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
 * Access: officers and seniors only (denyIfNotOfficer), and they may run
 * Stronghold scans in parallel.
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
import { findRosterSnapshot } from '../../../services/roster/index.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { isPrivilegedStrongholdScanUser } from '../../../utils/scanPermissions.js';
import { NoticeKind } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  deferUpdate,
  editAlert,
  editEmbed,
  replyAlert,
  updateAlert,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { buildOfficerOnlyAlert, buildTrustedBlockEmbed, isOfficerOrSenior } from '../helpers.js';
import { findTrustedEditConflict } from '../edit/trustedGuard.js';
import { MODELS_BY_TYPE } from './data.js';
import {
  clearEnrichSession,
  getCooldownWaitSeconds,
  getEnrichSession,
  markCooldown,
  refreshEnrichSession,
  takeEnrichSession,
} from './state.js';
import { buildEnrichSuccessEmbed } from './ui.js';
import { getScan } from '../../../utils/scanSession.js';
import {
  reserveStrongholdScanForInteraction,
  scanLimitAlertOptions,
} from '../../../utils/strongholdScanGate.js';
import { SCAN_ABORT_REASONS } from '../../../utils/scanAbortReasons.js';
import { createLongRunningReplyEditor } from '../../../utils/longRunningReply.js';
import {
  beginEnrichScan,
  buildCumulativeEnrichResult,
  buildEnrichCumulativeState,
  buildEnrichResultCard,
  buildInitialEnrichProgress,
  dispatchEnrichCompletionDm,
  editEnrichError,
  executeEnrichScan,
  loadEnrichTarget,
  persistEnrichSession,
  resolveEnrichCompletionOutcome,
  resolveEnrichTargetVisibility,
  resolveScanCancelState,
  settleScanCancelState,
} from './runner.js';

export {
  buildEnrichCumulativeState,
  buildInitialEnrichProgress,
  resolveEnrichCompletionOutcome,
  resolveEnrichTargetVisibility,
  resolveScanCancelState,
};

export function createEnrichHandlers({ services }) {
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
    const lang = await getUserLanguage(interaction.user.id, {
      UserPreferenceModel: UserPreference,
    });
    const resolvedCap = cap ?? config.strongholdDeepCandidateLimit;
    const replyEditor = createLongRunningReplyEditor(interaction);
    const target = await loadEnrichTarget({
      name,
      guildId: interaction.guild?.id || '',
      existingSession,
      lang,
      replyEditor,
    });
    if (!target) return;

    const scan = await beginEnrichScan({
      interaction,
      name,
      existingSession,
      resolvedCap,
      replyEditor,
      found: target.found,
      meta: target.meta,
      guildMembers: target.guildMembers,
      lang,
    });
    const { result, error } = await executeEnrichScan({
      name,
      meta: target.meta,
      guildMembers: target.guildMembers,
      resolvedCap,
      existingSession,
      scan,
    });
    if (error) {
      await editEnrichError(
        replyEditor,
        'dialogue.enrich.scanStopped',
        lang,
        { name, reason: error.message || t('dialogue.scan.unexpectedError', lang) },
        { clearContent: true }
      );
      return;
    }
    if (!result) {
      await editEnrichError(replyEditor, 'dialogue.enrich.scanFailed', lang, { name });
      return;
    }

    const cumulative = buildEnrichCumulativeState({
      existingSession,
      result,
      existingCharacters: target.found.entry.allCharacters,
      meta: target.meta,
    });
    const session = persistEnrichSession({
      interaction,
      found: target.found,
      meta: target.meta,
      targetIsHidden: target.targetIsHidden,
      resolvedCap,
      existingSession,
      sessionProgress: cumulative.sessionProgress,
    });
    const cumulativeResult = buildCumulativeEnrichResult(result, cumulative);
    if (existingSession) refreshEnrichSession(existingSession);

    const card = buildEnrichResultCard({
      name,
      targetIsHidden: target.targetIsHidden,
      meta: target.meta,
      found: target.found,
      existingSession,
      cumulative,
      cumulativeResult,
      session,
      lang,
    });
    await replyEditor.edit({
      content: '',
      embeds: [card.embed],
      components: card.buttonRow ? [card.buttonRow] : [],
    });
    dispatchEnrichCompletionDm({
      interaction,
      replyEditor,
      name,
      meta: target.meta,
      state: card.state,
      cumulative,
      cumulativeResult,
      lang,
    });
  }

  // Hard gate: enrich runs a long Stronghold scan that needs the bot
  // owner's residential-IP worker. Restricted to officers/seniors so a
  // non-privileged user does not get a confusing "service offline"
  // error when the worker is down. Must come before any deferReply so
  // the ephemeral reply lands cleanly.
  async function denyIfNotOfficer(interaction, commandLabel) {
    if (isPrivilegedStrongholdScanUser(interaction.user.id)) return false;
    const lang = await resolveInteractionLang(interaction);
    await replyAlert(interaction, buildOfficerOnlyAlert('dialogue.enrich.restricted', lang, { command: commandLabel }));
    return true;
  }

  async function startReservedEnrichFlow(interaction, {
    name,
    cap,
    reservationLabel,
    deferInteraction = deferReply,
    existingSession = null,
    cooldownCopy,
  }) {
    const cooldownWait = getCooldownWaitSeconds(name);
    if (cooldownWait > 0) {
      await replyAlert(interaction, { kind: NoticeKind.BUSY, ...cooldownCopy(cooldownWait) });
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
        kind: NoticeKind.EXPIRED,
        ...t('dialogue.enrich.sessionExpired', lang),
      });
      return null;
    }
    if (session.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        kind: NoticeKind.GUARD,
        ...t('dialogue.enrich.notYourSession', lang, { action: t(`dialogue.enrich.${actionLabel}`, lang) }),
      });
      return null;
    }
    return session;
  }

  async function startNewEnrichScan(interaction, name, cap, lang) {
    await startReservedEnrichFlow(interaction, {
      name,
      cap,
      reservationLabel: `/la-list enrich ${name}`,
      cooldownCopy: (wait) => t('dialogue.enrich.cooldown', lang, { seconds: wait, name }),
    });
  }

  async function handleListEnrichCommand(interaction) {
    if (await denyIfNotOfficer(interaction, '/la-list enrich')) return;
    const lang = await resolveInteractionLang(interaction);

    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);
    const cap = interaction.options.getInteger('deep_limit') ?? config.strongholdDeepCandidateLimit;
    await startNewEnrichScan(interaction, name, cap, lang);
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
      await replyAlert(interaction, {
        kind: NoticeKind.INPUT,
        ...t('dialogue.enrich.invalidButton', lang),
      });
      return;
    }

    const name = normalizeCharacterName(rawName);
    const cap = config.strongholdDeepCandidateLimit;
    await startNewEnrichScan(interaction, name, cap, lang);
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
      cooldownCopy: (wait) => t('dialogue.enrich.continueCooldown', lang, { seconds: wait, name: session.entryName }),
    });
  }

  async function handleListEnrichConfirmButton(interaction) {
    const sessionId = interaction.customId.split(':')[2];
    const session = await requireOwnedEnrichSession(interaction, sessionId, 'actionConfirm');
    if (!session) return;
    // Two quick clicks can both pass the check above before either writes;
    // the first to take the session confirms, the other only acknowledges.
    if (!takeEnrichSession(sessionId)) {
      await deferUpdate(interaction);
      return;
    }
    const lang = await resolveInteractionLang(interaction);

    await deferUpdate(interaction);

    const Model = MODELS_BY_TYPE[session.type];

    await connectDB();
    const altNames = session.newAlts.map((a) => a.name);
    if (altNames.length === 0) {
      await editAlert(interaction, {
        kind: NoticeKind.EMPTY,
        ...t('dialogue.enrich.nothing', lang),
      }, { components: [] });
      clearEnrichSession(sessionId);
      return;
    }

    const currentEntry = await Model.findById(session.entryId).lean();
    if (!currentEntry) {
      await editAlert(interaction, {
        kind: NoticeKind.EMPTY,
        ...t('dialogue.enrich.noEntry', lang, { name: session.entryName }),
      }, { components: [] });
      clearEnrichSession(sessionId);
      return;
    }
    // Confirm can arrive minutes after discovery; enforce the same Trusted
    // roster boundary as manual edits using the current protected names.
    const trusted = await findTrustedEditConflict(currentEntry, altNames);
    if (trusted) {
      await editEmbed(interaction, buildTrustedBlockEmbed(currentEntry.name, trusted.reason, {
        via: trusted.name, lang, record: await findRosterSnapshot(currentEntry.name),
      }), { components: [] });
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
    // Read back once and use it for both the broadcast and the success
    // card's running total.
    const enrichedEntry = await Model.findById(session.entryId).lean().catch(() => null);
    const trackedTotal = Array.isArray(enrichedEntry?.allCharacters)
      ? enrichedEntry.allCharacters.length
      : 0;

    if (typeof broadcastListChange === 'function') {
      if (enrichedEntry) {
        broadcastListChange(
          'enriched',
          enrichedEntry,
          { type: session.type, guildId: enrichedEntry.guildId || '' },
          {
            onlyOwner: enrichedEntry.scope === 'server',
            newAltNames: altNames,
            rosterCharacters: session.newAlts,
          }
        ).catch((err) => console.warn('[enrich] Broadcast failed:', err?.message || err));
      }
    }

    clearEnrichSession(sessionId);

    await editEmbed(interaction, buildEnrichSuccessEmbed(session, updateResult, lang, { trackedTotal }), {
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
        kind: NoticeKind.EXPIRED,
        ...t('dialogue.enrich.sessionExpired', lang),
      }, { content: '', components: [] });
      return;
    }
    if (session.callerId !== interaction.user.id) {
      await replyAlert(interaction, {
        kind: NoticeKind.GUARD,
        ...t('dialogue.enrich.notYourSession', lang, { action: t('dialogue.enrich.actionCancel', lang) }),
      });
      return;
    }

    clearEnrichSession(sessionId);

    await updateAlert(interaction, {
      kind: NoticeKind.DONE,
      ...t('dialogue.enrich.cancelled', lang),
    }, { content: null, components: [] });
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
    const state = resolveScanCancelState({
      scan,
      userId: interaction.user.id,
      isPrivileged: isOfficerOrSenior(interaction.user.id),
    });
    const canCancel = await settleScanCancelState({ state, interaction, lang });
    if (!canCancel) return;

    scan.cancelFlag.cancelled = true;
    scan.cancelFlag.reason = SCAN_ABORT_REASONS.userStopped;

    await replyAlert(interaction, {
      kind: NoticeKind.PROGRESS,
      ...t('dialogue.enrich.stopSent', lang),
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
