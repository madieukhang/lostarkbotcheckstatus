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
 *   - The blacklist edge case (target griefed under one alt, has more)
 *     is exactly when an officer wants the option to opt in to a
 *     thorough discovery on demand.
 *
 * Access: everyone can run this, but regular users are limited to one
 * active Stronghold scan at a time. Officers/seniors can run parallel
 * operational scans when needed.
 *
 * Cooldown: 30 seconds per entry (in-memory). Deep scans burn bible
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
  replyContent,
  updateAlert,
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
// rate-limit ceiling and tight enough that progress feels live rather
// than batched.
const PROGRESS_EDIT_THROTTLE_MS = 15 * 1000;
const PROGRESS_EDIT_FAILURE_LIMIT = 3;

export function createEnrichHandlers({ client, services }) {
  // Guild-broadcast notifier shared with /la-list add/edit. Fired on Confirm
  // so the notify channels learn an entry just gained newly-discovered alts.
  const { broadcastListChange } = services || {};

  async function replyScanLimit(interaction, active) {
    await replyAlert(interaction, scanLimitAlertOptions(active));
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
          title: 'No List Entry',
          description: `**${name}** has no entry in any list.`,
          footer: 'Use /la-list add to create the entry first; enrich only appends to existing entries.',
        })],
        components: [],
      });
      return;
    }

    // Roster visibility probe. Drives the "hidden roster notice" block
    // in the result card so officers know whether the alt list came
    // from a fingerprint match (stronger constraint) or a direct
    // roster scan. Skip the probe on Continue passes since the answer
    // is cached on the session and a re-probe would burn an extra
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
            title: 'Profile Not Found',
            description: `Could not load lostark.bible profile for **${name}**.`,
            footer: 'Profile may be hidden behind a private flag, the name may be misspelled, or bible may be down.',
          })],
          components: [],
        });
        return;
      }
      targetIsHidden = probe.rosterVisibility === 'hidden';
    }

    // Up-front bible probe so we can fail fast on no-guild / no-stronghold
    // before paying the multi-minute candidate fan-out. ScraperAPI is
    // allowed for this single-request probe because bible direct can flap
    // 429/503 and a one-off fallback is cheap quota-wise.
    const meta = existingSession?.meta || await fetchCharacterMeta(name, {
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      viaWorker: true,
    });
    if (!meta) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Profile Not Found',
          description: `Could not fetch character meta for **${name}** from lostark.bible.`,
          footer: 'Profile may be hidden, the name may be misspelled, or bible may be temporarily down.',
        })],
        components: [],
      });
      return;
    }
    if (!meta.guildName) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'No Guild on Bible',
          description: `**${name}** has no guild listed on lostark.bible. Stronghold deep scan requires a guild member list to walk.`,
          footer: 'Use /la-list edit additional_names to manually append known alts when auto-discovery is impossible.',
        })],
        components: [],
      });
      return;
    }

    // Guild member fetch is one request, so ScraperAPI fallback is on
    // (cheap) when bible direct flaps. Per-candidate scan below stays
    // direct-only.
    const guildMembers = await fetchGuildMembers(name, {
      timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      cacheKey: meta.guildName,
      viaWorker: true,
    });
    if (guildMembers.length === 0) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Guild Member List Unavailable',
          description: `Could not fetch the guild member list for **${name}** even with ScraperAPI fallback.`,
          footer: 'Bible may be down or the guild is empty; try again in a few minutes.',
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

    // Pre-compute the per-pass candidate count for the initial 0%
    // progress embed. We subtract the already-scanned set so the
    // progress bar reads correctly on a Continue resume.
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
          title: `Scan stopped · ${name}`,
          description: `Reason: **${scanThrownError.message || 'unexpected detector error'}**`,
          footer: 'No list changes were made. Try again after bible cools down.',
        })],
        components: [],
      });
      return;
    }

    // Defensive: detectAltsViaStronghold can return null on early-exit
    // failure modes (no meta / no guild / no stronghold). At this point
    // we already validated meta + guild upstream so null is unexpected,
    // but render a clean error rather than crashing the editReply.
    if (!result) {
      await replyEditor.edit({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: `Scan failed · ${name}`,
          description: 'The detector returned no result. Bible may have rejected the meta probe mid-scan.',
          footer: 'Re-run /la-list enrich; the cooldown will pass in 30s.',
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

    // Diff against entry.allCharacters to surface only NEW alts. Names
    // are stored case-sensitive in the DB so we lowercase both sides
    // for the membership check.
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

    const summaryLine =
      `I scanned **${meta.guildName}** for stronghold matches with **${name}**` +
      (existingSession ? ' (resumed from prior pass).' : '.');

    let actionHint = '';
    if (cumulativeAlts.length === 0) {
      actionHint = 'No alts matched the target stronghold yet.';
    } else if (newAlts.length === 0) {
      actionHint = `All ${cumulativeAlts.length} discovered alt(s) are already on this ${ctx.label} entry.`;
    } else {
      actionHint = `**${newAlts.length}** of ${cumulativeAlts.length} discovered alt(s) are not on this ${ctx.label} entry yet. ` +
        `Confirm to append them to \`allCharacters\`.`;
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
    await replyAlert(interaction, {
      severity: AlertSeverity.WARNING,
      title: 'Officers / Seniors only',
      description:
        `\`${commandLabel}\` runs a long Stronghold scan that depends on the bot owner's ` +
        `residential-IP worker. The command is restricted to officers and seniors so a regular ` +
        `user does not see a confusing error when the worker is offline. Ask an officer to run it for you.`,
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
      await replyContent(interaction, cooldownMessage(cooldownWait));
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
    const session = getEnrichSession(sessionId);
    if (!session) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Session Expired',
        description: 'This enrich preview is older than the 5-minute session window.',
        footer: 'Re-run /la-list enrich to start a fresh scan.',
      });
      return null;
    }
    if (session.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Not Your Session',
        description: `Only the user who started this enrich session can ${actionLabel}.`,
      });
      return null;
    }
    return session;
  }

  async function handleListEnrichCommand(interaction) {
    if (await denyIfNotOfficer(interaction, '/la-list enrich')) return;

    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);
    const cap = interaction.options.getInteger('deep_limit') ?? config.strongholdDeepCandidateLimit;

    await startReservedEnrichFlow(interaction, {
      name,
      cap,
      reservationLabel: `/la-list enrich ${name}`,
      cooldownMessage: (wait) => `⏳ Please wait ${wait}s before re-enriching **${name}**.`,
    });
  }

  /**
   * Triggered by the "Enrich now" button posted on a /la-list add
   * success card when the entry was created against a hidden roster.
   * customId shape: `list-add:enrich-hidden:<encodedName>`
   */
  async function handleListAddEnrichHiddenButton(interaction) {
    if (await denyIfNotOfficer(interaction, '/la-list enrich')) return;

    const parts = interaction.customId.split(':');
    const encoded = parts.slice(2).join(':');
    const rawName = decodeURIComponent(encoded || '').trim();
    if (!rawName) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Invalid Button',
        description: 'Could not read the entry name from the button. Use `/la-list enrich` directly.',
      });
      return;
    }

    const name = normalizeCharacterName(rawName);
    const cap = config.strongholdDeepCandidateLimit;

    await startReservedEnrichFlow(interaction, {
      name,
      cap,
      reservationLabel: `/la-list enrich ${name}`,
      cooldownMessage: (wait) => `⏳ Please wait ${wait}s before re-enriching **${name}**.`,
    });
  }

  /**
   * Continue-scan button: resume the same enrich session with the prior
   * pass's scanned-names fed back as excludeNames so the next pass walks
   * only fresh candidates. Re-uses the regular-user one-active-scan
   * gate + cooldown and refreshes the session TTL.
   */
  async function handleListEnrichContinueButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = await requireOwnedEnrichSession(interaction, sessionId, 'continue it');
    if (!session) return;
    refreshEnrichSession(session);

    await startReservedEnrichFlow(interaction, {
      name: session.entryName,
      cap: session.cap,
      reservationLabel: `/la-list enrich continue ${session.entryName}`,
      deferInteraction: deferUpdate,
      existingSession: session,
      cooldownMessage: (wait) => `⏳ Please wait ${wait}s before continuing the scan for **${session.entryName}**.`,
    });
  }

  async function handleListEnrichConfirmButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = await requireOwnedEnrichSession(interaction, sessionId, 'confirm it');
    if (!session) return;

    await deferUpdate(interaction);

    const Model = MODELS_BY_TYPE[session.type];
    if (!Model) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Internal Error',
        description: `Unknown list type "${session.type}".`,
        footer: 'Report this to an officer; the entry was not modified.',
      }, { components: [] });
      return;
    }

    await connectDB();
    const altNames = (session.newAlts || []).map((a) => a.name);
    if (altNames.length === 0) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Nothing to Save',
        description: 'No new alts were discovered, so the entry was not modified.',
        footer: 'Re-run /la-list enrich if bible has cooled down and you want a fresh pass.',
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

    await editEmbed(interaction, buildEnrichSuccessEmbed(session, updateResult), {
      content: '',
      components: [],
    });
  }

  async function handleListEnrichCancelButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = getEnrichSession(sessionId);
    if (!session) {
      await updateAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Session Expired',
        description: 'This enrich preview is older than the 5-minute session window.',
      }, { content: '', components: [] });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Not Your Session',
        description: 'Only the user who started this enrich session can cancel it.',
      });
      return;
    }

    clearEnrichSession(sessionId);

    await updatePayload(interaction, {
      content: 'Cancelled · no changes made to the entry.',
      embeds: [],
      components: [],
    });
  }

  /**
   * Stop button handler. Posted on long-running scan progress embeds
   * (enrich + roster deep:true) so the caller can interrupt a stuck
   * scan without waiting for the 15-min Discord webhook timeout.
   */
  async function handleScanCancelButton(interaction) {
    const sessionId = interaction.customId.split(':')[1];
    const scan = getScan(sessionId);
    if (!scan) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Scan Already Finished',
        description: 'This scan has already completed or was cancelled. Re-run the command if you want a fresh scan.',
      });
      return;
    }
    if (!isOfficerOrSenior(interaction.user.id) && scan.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Not Authorised',
        description: 'Only the user who started this scan (or an officer/senior) can stop it.',
      });
      return;
    }

    if (scan.cancelFlag.cancelled) {
      await replyContent(interaction, 'Already stopping...');
      return;
    }

    scan.cancelFlag.cancelled = true;
    scan.cancelFlag.reason = 'user-stopped';
    scan.cancelFlag.label = 'Stopped by user';
    scan.cancelFlag.detail = 'Stop button clicked.';

    await replyAlert(interaction, {
      severity: AlertSeverity.INFO,
      titleIcon: '🛑',
      title: 'Stop signal sent',
      description: 'The scan worker will exit at the end of its current candidate fetch (a few seconds at most).',
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
