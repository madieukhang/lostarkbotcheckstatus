/**
 * /la-list enrich <name>
 *
 * Run a stronghold deep scan against an existing list entry and append
 * the discovered alts to its `allCharacters` array. The entry must
 * already exist (created via `/la-list add` or `/la-list multiadd`); this
 * command does NOT create entries, only enriches them.
 *
 * Why this is a separate command:
 *   - `/la-list add` is on the user-facing fast path and must reply within
 *     Discord's 3s defer budget. Stronghold deep scans take ~10-15 minutes
 *     in production with the gentle cap-300 scan profile.
 *   - Most adds do not need a deep scan: visible-roster characters
 *     return their full alt list directly via the roster scrape.
 *   - Blacklist entries may identify only one alt while the account has
 *     others, so officers can opt into thorough discovery on demand.
 *
 * Access: everyone can run this, but regular users are limited to one
 * active Stronghold scan at a time. Officers/seniors can run parallel
 * operational scans when needed.
 *
 * Cooldown: 30 seconds per entry (in-memory). Deep scans consume Bible
 * quota; the cooldown prevents an accidental double-click from
 * doubling the request count.
 *
 * Result card: a single unified `buildScanResultEmbed` is rendered for
 * every terminal branch (completed, stopped, cap-hit, no-alts). The
 * matrix of buttons (Confirm / Continue / Discard) is selected from the
 * post-scan state so officers can resume a partial scan without
 * re-running the slash command from scratch.
 */

import { connectDB } from '../../../db.js';
import config from '../../../config.js';
import UserPreference from '../../../models/UserPreference.js';
import {
  fetchCharacterMeta,
  fetchGuildMembers,
  detectAltsViaStronghold,
  buildRosterCharacters,
} from '../../../services/roster/index.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { isPrivilegedStrongholdScanUser } from '../../../utils/scanPermissions.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  deferUpdate,
  editAlert,
  editEmbed,
  replyAlert,
  replyNotice,
  updateAlert,
  updateNotice,
  updatePayload,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  buildScanResultEmbed,
  buildScanResultButtons,
} from '../../../utils/scanResultEmbed.js';
import { isOfficerOrSenior } from '../helpers.js';
import {
  findEntryByName,
  LIST_LABELS,
  MODELS_BY_TYPE,
} from './data.js';
import {
  clearEnrichSession,
  createEnrichSession,
  getCooldownWaitSeconds,
  getEnrichSession,
  markCooldown,
  refreshEnrichSession,
  touchEnrichSession,
} from './state.js';
import { buildEnrichProgressEmbed, buildEnrichSuccessEmbed } from './ui.js';
import {
  buildStopButtonRow,
  newScanSessionId,
  registerScan,
  unregisterScan,
  getScan,
} from '../../../utils/scanSession.js';
import {
  reserveStrongholdScanForInteraction,
  scanLimitAlertOptions,
} from '../../../utils/strongholdScanGate.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../../utils/scanCompletionDm.js';
import { createLongRunningReplyEditor } from '../../../utils/longRunningReply.js';
import { mergeAltsByName } from '../../../utils/alts.js';
import { rosterUrl } from '../../../utils/rosterLink.js';

// Discord webhook edits are rate-limited (5 per 5s). 15s throttle gives
// ~40-60 updates over a 10-15 minute gentle-mode scan; well under the
// rate-limit ceiling while keeping progress updates timely.
const PROGRESS_EDIT_THROTTLE_MS = 15 * 1000;
const PROGRESS_EDIT_FAILURE_LIMIT = 3;

export function createEnrichHandlers({ client, services }) {
  // Guild-broadcast notifier shared with /la-list add/edit. Fired on Confirm
  // so the notify channels learn an entry just gained newly-discovered alts.
  const { broadcastListChange } = services || {};

  const resolveInteractionLang = (interaction) => getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

  async function replyScanLimit(interaction, active) {
    const lang = await resolveInteractionLang(interaction);
    await replyAlert(interaction, scanLimitAlertOptions(active, lang));
  }

  /**
   * Runs the enrich pipeline post-validation. Caller is responsible for:
   *   - regular-user one-active-scan gate
   *   - cooldown gate + markCooldown
   *   - deferReply / deferUpdate (this function only does editReply)
   *
   * @param {object} interaction
   * @param {object} options
   * @param {string} options.name
   * @param {number} [options.cap]
   * @param {object} [options.existingSession] - When set, this is a Continue-scan
   *   resume: the session's scannedNames feed excludeNames so the next pass
   *   skips already-visited candidates, and the result is merged into
   *   session.allDiscoveredAlts rather than starting fresh.
  */
  async function runEnrichFlow(interaction, { name, cap, existingSession = null }) {
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const resolvedCap = cap ?? config.strongholdDeepCandidateLimit;
    const replyEditor = createLongRunningReplyEditor(interaction);

    const found = await findEntryByName(name);
    if (!found) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.enrich.noEntry', lang, { name }),
          lang,
        })],
        components: [],
      });
      return;
    }

    // Roster visibility probe. Drives the "hidden roster notice" block
    // in the result card so officers know whether the alt list came
    // from a fingerprint match (stronger constraint) or a direct
    // roster scan. Skip the probe on Continue passes since the answer
    // is cached on the session and a re-probe would consume an extra
    // bible request per Continue click.
    let targetIsHidden;
    if (existingSession?.targetIsHidden !== undefined) {
      targetIsHidden = existingSession.targetIsHidden;
    } else {
      const probe = await buildRosterCharacters(name, { hiddenRosterFallback: true, viaWorker: true });
      if (!probe.hasValidRoster) {
        await replyEditor.edit({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            ...t('dialogue.enrich.profileMissing', lang, { name }),
            lang,
          })],
          components: [],
        });
        return;
      }
      targetIsHidden = probe.rosterVisibility === 'hidden';
    }

    // Probe Bible before the multi-minute candidate fan-out to reject targets
    // without guild or stronghold data. ScraperAPI is allowed for this one
    // request because direct Bible access may return transient 429/503 errors.
    const meta = existingSession?.meta || await fetchCharacterMeta(name, {
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      viaWorker: true,
    });
    if (!meta) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.enrich.metaMissing', lang, { name }),
          lang,
        })],
        components: [],
      });
      return;
    }
    if (!meta.guildName) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.enrich.noGuild', lang, { name }),
          lang,
        })],
        components: [],
      });
      return;
    }

    // Guild-member lookup uses one ScraperAPI fallback request when direct
    // Bible access fails. The per-candidate scan below remains direct-only.
    const guildMembers = await fetchGuildMembers(name, {
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      cacheKey: meta.guildName,
      viaWorker: true,
    });
    if (guildMembers.length === 0) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.enrich.guildUnavailable', lang, { name }),
          lang,
        })],
        components: [],
      });
      return;
    }

    const sessionId = newScanSessionId();
    const cancelFlag = { cancelled: false };
    registerScan(sessionId, {
      cancelFlag,
      callerId: interaction.user.id,
      startedAt: Date.now(),
      label: `${name} (enrich${existingSession ? ' · resume' : ''})`,
    });

    // Pre-compute the per-pass candidate count for the initial 0% progress
    // embed. Already-scanned names are excluded from resumed-pass totals.
    const excludeSet = new Set(
      (existingSession?.scannedNames ?? []).map((n) => String(n).toLowerCase())
    );
    const passEligible = guildMembers
      .filter((m) => m.name !== name && m.ilvl >= 1700 && !excludeSet.has(String(m.name).toLowerCase()))
      .length;
    const passLimit = resolvedCap || passEligible;
    const startedAt = Date.now();
    const initialProgress = {
      scannedCandidates: 0,
      totalCandidates: Math.min(passEligible, passLimit),
      failedCandidates: 0,
      altsFound: 0,
      currentBackoffMs: 1500,
      totalMembers: guildMembers.length,
      startedAt,
    };
    const stopRow = buildStopButtonRow(sessionId, { lang });
    await replyEditor.edit({
      content: '',
      embeds: [buildEnrichProgressEmbed({
        entry: found.entry,
        foundType: found.type,
        meta,
        progress: initialProgress,
        lang,
      })],
      components: [stopRow],
    });

    let lastProgressEdit = startedAt;
    let progressEditFailures = 0;
    const onProgress = (progress) => {
      const now = Date.now();
      const isFinal = progress.scannedCandidates >= progress.totalCandidates;
      if (!isFinal && now - lastProgressEdit < PROGRESS_EDIT_THROTTLE_MS) return;
      lastProgressEdit = now;
      if (isFinal) return;
      const buttonRow = cancelFlag.cancelled
        ? buildStopButtonRow(sessionId, { disabled: true, label: t('common.actions.stopping', lang), lang })
        : stopRow;
      replyEditor.edit({
        content: '',
        embeds: [buildEnrichProgressEmbed({
          entry: found.entry,
          foundType: found.type,
          meta,
          progress: { ...progress, totalMembers: guildMembers.length, startedAt },
          lang,
        })],
        components: [buttonRow],
      }).then(() => {
        progressEditFailures = 0;
      }).catch((err) => {
        progressEditFailures += 1;
        console.warn('[enrich] Progress edit failed:', err?.message || err);
        if (progressEditFailures >= PROGRESS_EDIT_FAILURE_LIMIT && !cancelFlag.cancelled) {
          cancelFlag.cancelled = true;
          cancelFlag.reason = 'discord-progress-update-failed';
          cancelFlag.label = 'Discord update failed';
          cancelFlag.detail = 'Could not update the scan card repeatedly.';
        }
      });
    };

    let result;
    let scanThrownError = null;
    try {
      result = await detectAltsViaStronghold(name, {
        targetMeta: meta,
        guildMembers,
        candidateLimit: resolvedCap,
        useScraperApiForCandidates: false,
        onProgress,
        cancelFlag,
        excludeNames: existingSession?.scannedNames ?? [],
        viaWorker: true,
      });
    } catch (err) {
      scanThrownError = err;
    } finally {
      unregisterScan(sessionId);
    }

    if (scanThrownError) {
      await replyEditor.edit({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.enrich.scanStopped', lang, { name, reason: scanThrownError.message || t('dialogue.scan.unexpectedError', lang) }),
          lang,
        })],
        components: [],
      });
      return;
    }

    // detectAltsViaStronghold may return null on early exits such as missing
    // meta, guild, or stronghold data. Upstream validation makes this branch
    // unexpected, but it still renders an error instead of failing editReply.
    if (!result) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.enrich.scanFailed', lang, { name }),
          lang,
        })],
        components: [],
      });
      return;
    }

    // Merge this pass into the cumulative session state. On a fresh run
    // existingSession is null and the merge degrades to "use this pass".
    const cumulativeAlts = mergeAltsByName(
      existingSession?.allDiscoveredAlts ?? [],
      result.alts || []
    );
    const cumulativeScannedNames = [
      ...(existingSession?.scannedNames ?? []),
      ...(result.scannedNames || []),
    ];
    const cumulativeScanned = (existingSession?.scanStats?.scanned ?? 0) + (result.scannedCandidates || 0);
    const cumulativeAttempted =
      (existingSession?.scanStats?.attempted ?? 0) +
      (result.attemptedCandidates ?? result.scannedCandidates ?? 0);
    const cumulativeFailed = (existingSession?.scanStats?.failed ?? 0) + (result.failedCandidates || 0);
    const cumulativeRateLimitRetries =
      (existingSession?.scanStats?.rateLimitRetries ?? 0) + (result.rateLimitRetries || 0);

    // Diff against entry.allCharacters to surface only new alts. Database
    // names retain case, so both sides are lowercased for membership checks.
    const existingChars = new Set(
      (found.entry.allCharacters || []).map((n) => String(n).toLowerCase())
    );
    const newAlts = cumulativeAlts.filter(
      (alt) => !existingChars.has(String(alt.name).toLowerCase())
    );

    // Reuse or create the enrich session that backs the Confirm /
    // Continue / Discard buttons. Continue paths refresh the TTL so
    // the 5-minute expiry doesn't fire between pass 1 and pass 2.
    let session;
    if (existingSession) {
      Object.assign(existingSession, {
        allDiscoveredAlts: cumulativeAlts,
        newAlts: newAlts.map((a) => ({ name: a.name, classId: a.classId, itemLevel: a.itemLevel })),
        scannedNames: cumulativeScannedNames,
        scanStats: {
          scanned: cumulativeScanned,
          attempted: cumulativeAttempted,
          failed: cumulativeFailed,
          rateLimitRetries: cumulativeRateLimitRetries,
          totalAlts: cumulativeAlts.length,
          guildName: meta.guildName,
        },
      });
      session = touchEnrichSession(existingSession.sessionId) || existingSession;
    } else {
      session = createEnrichSession({
        callerId: interaction.user.id,
        type: found.type,
        entryId: String(found.entry._id),
        entryName: found.entry.name,
        meta: {
          guildName: meta.guildName,
          strongholdName: meta.strongholdName,
          rosterLevel: meta.rosterLevel,
        },
        targetIsHidden,
        cap: resolvedCap,
        allDiscoveredAlts: cumulativeAlts,
        newAlts: newAlts.map((a) => ({ name: a.name, classId: a.classId, itemLevel: a.itemLevel })),
        scannedNames: cumulativeScannedNames,
        scanStats: {
          scanned: cumulativeScanned,
          attempted: cumulativeAttempted,
          failed: cumulativeFailed,
          rateLimitRetries: cumulativeRateLimitRetries,
          totalAlts: cumulativeAlts.length,
          guildName: meta.guildName,
        },
      });
    }

    // Build the cumulative result envelope for the embed renderer:
    // counts that should grow across passes (scanned, failed) come from
    // the session, while invariants (totalEligibleInGuild, candidateLimit)
    // and per-pass-only flags (cancelled) come from the latest pass.
    const cumulativeResult = {
      ...result,
      scannedCandidates: cumulativeScanned,
      checkedCandidates: cumulativeScanned,
      attemptedCandidates: cumulativeAttempted,
      failedCandidates: cumulativeFailed,
      rateLimitRetries: cumulativeRateLimitRetries,
      alts: cumulativeAlts,
      scannedNames: cumulativeScannedNames,
    };
    if (existingSession) {
      refreshEnrichSession(existingSession);
    }

    const ctx = LIST_LABELS[found.type];
    const newAltsSet = new Set(newAlts.map((a) => String(a.name).toLowerCase()));
    const profileUrl = rosterUrl(name);

    const summaryLine = t('dialogue.enrich.summary', lang, {
      guild: meta.guildName,
      name,
      resumed: existingSession ? t('dialogue.enrich.resumed', lang) : '',
    });

    let actionHint = '';
    if (cumulativeAlts.length === 0) {
      actionHint = t('dialogue.enrich.noAlts', lang);
    } else if (newAlts.length === 0) {
      actionHint = t('dialogue.enrich.allKnown', lang, { count: cumulativeAlts.length, list: t(`dialogue.broadcast.list.${found.type}`, lang) });
    } else {
      actionHint = t('dialogue.enrich.newAlts', lang, { newCount: newAlts.length, total: cumulativeAlts.length, list: t(`dialogue.broadcast.list.${found.type}`, lang) });
    }

    const { embed, state } = buildScanResultEmbed({
      target: {
        name,
        isHidden: targetIsHidden,
        guildName: meta.guildName,
        profileUrl,
      },
      result: cumulativeResult,
      alts: cumulativeAlts,
      newAltsSet,
      kind: 'enrich',
      contextStyle: { icon: ctx.icon, color: ctx.color },
      summaryLine,
      actionHint,
      lang,
    });

    const buttonRow = buildScanResultButtons({
      kind: 'enrich',
      sessionId: session.sessionId,
      hasAlts: newAlts.length > 0,
      hasRemaining: state.hasRemaining,
      newAltsCount: newAlts.length,
      lang,
    });

    await replyEditor.edit({
      content: '',
      embeds: [embed],
      components: buttonRow ? [buttonRow] : [],
    });

    // DM the caller so they don't have to keep the channel open during
    // a multi-minute scan. Outcome is derived from state + alt count.
    let outcome;
    if ((state.stopReason === 'stopped' || state.stopReason === 'failure-storm') && cumulativeAlts.length === 0) outcome = 'stopped-no-alts';
    else if (state.stopReason === 'stopped' || state.stopReason === 'failure-storm') outcome = 'stopped-with-alts';
    else if (cumulativeAlts.length === 0) outcome = 'no-alts';
    else outcome = 'completed';
    try {
      const reply = replyEditor.getMessage();
      sendScanCompletionDm({
        user: interaction.user,
        commandLabel: '/la-list enrich',
        scanTargetName: name,
        guildName: meta.guildName,
        channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
        resultMessageUrl: buildResultMessageUrl(interaction, reply),
        outcome,
        result: cumulativeResult,
        alts: newAlts,
        lang,
      }).catch(() => {});
    } catch (err) {
      console.warn('[enrich] DM dispatch failed:', err?.message || err);
    }
  }

  // Hard gate: enrich runs a long Stronghold scan that needs the bot
  // owner's residential-IP worker. Restricted to officers/seniors so a
  // non-privileged user does not get a confusing "service offline"
  // error when the worker is down. Must come before any deferReply so
  // the ephemeral reply lands cleanly.
  async function denyIfNotOfficer(interaction, commandLabel) {
    if (isPrivilegedStrongholdScanUser(interaction.user.id)) return false;
    const lang = await resolveInteractionLang(interaction);
    await replyAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.enrich.restricted', lang, { command: commandLabel }),
      lang,
    });
    return true;
  }

  async function startReservedEnrichFlow(interaction, {
    name,
    cap,
    reservationLabel,
    deferInteraction = deferReply,
    existingSession = null,
    cooldownMessage,
  }) {
    const cooldownWait = getCooldownWaitSeconds(name);
    if (cooldownWait > 0) {
      await replyNotice(interaction, cooldownMessage(cooldownWait), {
        severity: AlertSeverity.WARNING,
        lang: await resolveInteractionLang(interaction),
      });
      return;
    }

    const scanReservation = reserveStrongholdScanForInteraction(interaction, reservationLabel);
    if (!scanReservation.ok) {
      await replyScanLimit(interaction, scanReservation.active);
      return;
    }

    markCooldown(name);

    try {
      await deferInteraction(interaction);
      await runEnrichFlow(interaction, { name, cap, existingSession });
    } finally {
      scanReservation.release();
    }
  }

  async function requireOwnedEnrichSession(interaction, sessionId, actionLabel) {
    const lang = await resolveInteractionLang(interaction);
    const session = getEnrichSession(sessionId);
    if (!session) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.enrich.sessionExpired', lang),
        lang,
      });
      return null;
    }
    if (session.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.enrich.notYourSession', lang, { action: t(`dialogue.enrich.${actionLabel}`, lang) }),
        lang,
      });
      return null;
    }
    return session;
  }

  async function handleListEnrichCommand(interaction) {
    if (await denyIfNotOfficer(interaction, '/la-list enrich')) return;
    const lang = await resolveInteractionLang(interaction);

    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);
    const cap = interaction.options.getInteger('deep_limit') ?? config.strongholdDeepCandidateLimit;

    await startReservedEnrichFlow(interaction, {
      name,
      cap,
      reservationLabel: `/la-list enrich ${name}`,
      cooldownMessage: (wait) => `⏳ ${t('dialogue.enrich.cooldown', lang, { seconds: wait, name })}`,
    });
  }

  /**
   * Triggered by the "Enrich now" button posted on a /la-list add
   * success card when the entry was created against a hidden roster.
   * customId shape: `list-add:enrich-hidden:<encodedName>`
   */
  async function handleListAddEnrichHiddenButton(interaction) {
    if (await denyIfNotOfficer(interaction, '/la-list enrich')) return;
    const lang = await resolveInteractionLang(interaction);

    const parts = interaction.customId.split(':');
    const encoded = parts.slice(2).join(':');
    const rawName = decodeURIComponent(encoded || '').trim();
    if (!rawName) {
      const lang = await resolveInteractionLang(interaction);
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.enrich.invalidButton', lang),
        lang,
      });
      return;
    }

    const name = normalizeCharacterName(rawName);
    const cap = config.strongholdDeepCandidateLimit;

    await startReservedEnrichFlow(interaction, {
      name,
      cap,
      reservationLabel: `/la-list enrich ${name}`,
      cooldownMessage: (wait) => `⏳ ${t('dialogue.enrich.cooldown', lang, { seconds: wait, name })}`,
    });
  }

  /**
   * Continue-scan button: resume the same enrich session with the prior
   * pass's scanned-names fed back as excludeNames so the next pass walks
   * only fresh candidates. Re-uses the regular-user one-active-scan
   * gate + cooldown and refreshes the session TTL.
   */
  async function handleListEnrichContinueButton(interaction) {
    const lang = await resolveInteractionLang(interaction);
    const sessionId = interaction.customId.split(':')[2];
    const session = await requireOwnedEnrichSession(interaction, sessionId, 'actionContinue');
    if (!session) return;
    refreshEnrichSession(session);

    await startReservedEnrichFlow(interaction, {
      name: session.entryName,
      cap: session.cap,
      reservationLabel: `/la-list enrich continue ${session.entryName}`,
      deferInteraction: deferUpdate,
      existingSession: session,
      cooldownMessage: (wait) => `⏳ ${t('dialogue.enrich.continueCooldown', lang, { seconds: wait, name: session.entryName })}`,
    });
  }

  async function handleListEnrichConfirmButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = await requireOwnedEnrichSession(interaction, sessionId, 'actionConfirm');
    if (!session) return;
    const lang = await resolveInteractionLang(interaction);

    await deferUpdate(interaction);

    const Model = MODELS_BY_TYPE[session.type];
    if (!Model) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.enrich.internalType', lang, { type: session.type }),
        lang,
      }, { components: [] });
      return;
    }

    await connectDB();
    const altNames = (session.newAlts || []).map((a) => a.name);
    if (altNames.length === 0) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.enrich.nothing', lang),
        lang,
      }, { components: [] });
      clearEnrichSession(sessionId);
      return;
    }

    const updateResult = await Model.updateOne(
      { _id: session.entryId },
      {
        $addToSet: { allCharacters: { $each: altNames } },
        // Stronghold scan is bible-sourced; refresh source + timestamp so
        // a later re-enrich-when-stale loop can tell this entry was
        // touched recently. Keeps semantics aligned with /la-list add.
        $set: { enrichmentSource: 'bible', enrichedAt: new Date() },
      }
    );

    // Broadcast the enrichment to the guild notify channels, mirroring the
    // /la-list add/edit cards. Fetch the just-updated entry so the card's
    // headline count + scope routing reflect the appended alts. The scan
    // session carries {name, classId, itemLevel} for each new alt, passed as
    // rosterCharacters so the "🆕 New alts" field shows class icon + ilvl even
    // when those alts aren't in RosterSnapshot yet. Best-effort: a channel
    // failure must not break the Confirm reply, so it's fire-and-forget.
    if (typeof broadcastListChange === 'function') {
      const enrichedEntry = await Model.findById(session.entryId).lean().catch(() => null);
      if (enrichedEntry) {
        broadcastListChange(
          'enriched',
          enrichedEntry,
          { type: session.type, guildId: enrichedEntry.guildId || '' },
          {
            onlyOwner: enrichedEntry.scope === 'server',
            newAltNames: altNames,
            rosterCharacters: session.newAlts || [],
          }
        ).catch((err) => console.warn('[enrich] Broadcast failed:', err?.message || err));
      }
    }

    clearEnrichSession(sessionId);

    await editEmbed(interaction, buildEnrichSuccessEmbed(session, updateResult, lang), {
      content: '',
      components: [],
    });
  }

  async function handleListEnrichCancelButton(interaction) {
    const lang = await resolveInteractionLang(interaction);
    const sessionId = interaction.customId.split(':')[2];
    const session = getEnrichSession(sessionId);
    if (!session) {
      await updateAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.enrich.sessionExpired', lang),
        lang,
      }, { content: '', components: [] });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.enrich.notYourSession', lang, { action: t('dialogue.enrich.actionCancel', lang) }),
        lang,
      });
      return;
    }

    clearEnrichSession(sessionId);

    await updateNotice(interaction, t('dialogue.enrich.cancelled', lang), {
      severity: AlertSeverity.INFO,
      titleIcon: '✖️',
      lang,
      components: [],
    });
  }

  /**
   * Stop button handler. Posted on long-running scan progress embeds
   * (enrich + roster deep:true) so the caller can interrupt a stuck
   * scan without waiting for the 15-min Discord webhook timeout.
   */
  async function handleScanCancelButton(interaction) {
    const lang = await resolveInteractionLang(interaction);
    const sessionId = interaction.customId.split(':')[1];
    const scan = getScan(sessionId);
    if (!scan) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.enrich.scanFinished', lang),
        lang,
      });
      return;
    }
    if (!isOfficerOrSenior(interaction.user.id) && scan.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.enrich.stopRestricted', lang),
        lang,
      });
      return;
    }

    if (scan.cancelFlag.cancelled) {
      await replyNotice(interaction, t('dialogue.enrich.alreadyStopping', lang), {
        severity: AlertSeverity.INFO,
        titleIcon: '🛑',
        lang,
      });
      return;
    }

    scan.cancelFlag.cancelled = true;
    scan.cancelFlag.reason = 'user-stopped';
    scan.cancelFlag.label = 'Stopped by user';
    scan.cancelFlag.detail = 'Stop button clicked.';

    await replyAlert(interaction, {
      severity: AlertSeverity.INFO,
      titleIcon: '🛑',
      ...t('dialogue.enrich.stopSent', lang),
      lang,
    });
  }

  return {
    handleListEnrichCommand,
    handleListAddEnrichHiddenButton,
    handleListEnrichConfirmButton,
    handleListEnrichCancelButton,
    handleListEnrichContinueButton,
    handleScanCancelButton,
  };
}
