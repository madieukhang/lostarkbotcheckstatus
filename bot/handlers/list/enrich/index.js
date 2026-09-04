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
import { normalizeCharacterName, normalizeNameKey } from '../../../utils/names.js';
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

const SCAN_CANCEL_STATE_RULES = Object.freeze([
  { state: 'finished', matches: ({ scan }) => !scan },
  {
    state: 'restricted',
    matches: ({ scan, userId, isPrivileged }) => (
      Boolean(scan) && !isPrivileged && scan.callerId !== userId
    ),
  },
  {
    state: 'already-stopping',
    matches: ({ scan }) => Boolean(scan?.cancelFlag?.cancelled),
  },
]);

export function resolveScanCancelState(context) {
  return SCAN_CANCEL_STATE_RULES.find(({ matches }) => matches(context))?.state || 'ready';
}

async function settleScanCancelState({ state, interaction, lang }) {
  switch (state) {
    case 'finished':
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.enrich.scanFinished', lang),
        lang,
      });
      return false;
    case 'restricted':
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.enrich.stopRestricted', lang),
        lang,
      });
      return false;
    case 'already-stopping':
      await replyNotice(interaction, t('dialogue.enrich.alreadyStopping', lang), {
        severity: AlertSeverity.INFO,
        titleIcon: '🛑',
        lang,
      });
      return false;
    default:
      return true;
  }
}

async function editEnrichError(replyEditor, key, lang, values = {}, { clearContent = false } = {}) {
  const payload = {
    embeds: [buildAlertEmbed({
      severity: AlertSeverity.ERROR,
      ...t(key, lang, values),
      lang,
    })],
    components: [],
  };
  if (clearContent) payload.content = '';
  await replyEditor.edit(payload);
}

async function resolveEnrichTargetVisibility({ name, existingSession, lang, replyEditor }) {
  if (existingSession?.targetIsHidden !== undefined) {
    return { ok: true, targetIsHidden: existingSession.targetIsHidden };
  }
  const probe = await buildRosterCharacters(name, {
    hiddenRosterFallback: true,
    viaWorker: true,
  });
  if (probe.hasValidRoster) {
    return { ok: true, targetIsHidden: probe.rosterVisibility === 'hidden' };
  }
  await editEnrichError(replyEditor, 'dialogue.enrich.profileMissing', lang, { name });
  return { ok: false };
}

async function resolveEnrichMeta({ name, existingSession, lang, replyEditor }) {
  const meta = existingSession?.meta || await fetchCharacterMeta(name, {
    timeoutMs: config.strongholdDeepCandidateTimeoutMs,
    viaWorker: true,
  });
  if (!meta) {
    await editEnrichError(replyEditor, 'dialogue.enrich.metaMissing', lang, { name });
    return null;
  }
  if (!meta.guildName) {
    await editEnrichError(replyEditor, 'dialogue.enrich.noGuild', lang, { name });
    return null;
  }
  return meta;
}

async function loadEnrichTarget({ name, guildId, existingSession, lang, replyEditor }) {
  const found = await findEntryByName(name, guildId);
  if (!found) {
    await editEnrichError(replyEditor, 'dialogue.enrich.noEntry', lang, { name });
    return null;
  }

  const visibility = await resolveEnrichTargetVisibility({
    name,
    existingSession,
    lang,
    replyEditor,
  });
  if (!visibility.ok) return null;

  const meta = await resolveEnrichMeta({ name, existingSession, lang, replyEditor });
  if (!meta) return null;

  const guildMembers = await fetchGuildMembers(name, {
    timeoutMs: config.strongholdDeepCandidateTimeoutMs,
    cacheKey: meta.guildName,
    viaWorker: true,
  });
  if (guildMembers.length > 0) {
    return { found, meta, guildMembers, targetIsHidden: visibility.targetIsHidden };
  }
  await editEnrichError(replyEditor, 'dialogue.enrich.guildUnavailable', lang, { name });
  return null;
}

export function buildInitialEnrichProgress({
  guildMembers,
  name,
  existingSession,
  resolvedCap,
  startedAt,
}) {
  const excludedNames = new Set(
    (existingSession?.scannedNames ?? []).map(normalizeNameKey)
  );
  const passEligible = guildMembers.filter((member) => (
    member.name !== name
    && member.ilvl >= 1700
    && !excludedNames.has(normalizeNameKey(member.name))
  )).length;
  const passLimit = resolvedCap || passEligible;
  return {
    scannedCandidates: 0,
    totalCandidates: Math.min(passEligible, passLimit),
    failedCandidates: 0,
    altsFound: 0,
    currentBackoffMs: 1500,
    totalMembers: guildMembers.length,
    startedAt,
  };
}

function createEnrichProgressHandler({
  replyEditor,
  found,
  meta,
  guildMembers,
  startedAt,
  sessionId,
  stopRow,
  cancelFlag,
  lang,
}) {
  let lastProgressEdit = startedAt;
  let progressEditFailures = 0;
  return (progress) => {
    const now = Date.now();
    const isFinal = progress.scannedCandidates >= progress.totalCandidates;
    if (!isFinal && now - lastProgressEdit < PROGRESS_EDIT_THROTTLE_MS) return;
    lastProgressEdit = now;
    if (isFinal) return;

    const buttonRow = cancelFlag.cancelled
      ? buildStopButtonRow(sessionId, {
          disabled: true,
          label: t('common.actions.stopping', lang),
          lang,
        })
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
      if (progressEditFailures < PROGRESS_EDIT_FAILURE_LIMIT || cancelFlag.cancelled) return;
      Object.assign(cancelFlag, {
        cancelled: true,
        reason: 'discord-progress-update-failed',
        label: 'Discord update failed',
        detail: 'Could not update the scan card repeatedly.',
      });
    });
  };
}

async function beginEnrichScan({
  interaction,
  name,
  existingSession,
  resolvedCap,
  replyEditor,
  found,
  meta,
  guildMembers,
  lang,
}) {
  const sessionId = newScanSessionId();
  const cancelFlag = { cancelled: false };
  const startedAt = Date.now();
  registerScan(sessionId, {
    cancelFlag,
    callerId: interaction.user.id,
    startedAt,
    label: `${name} (enrich${existingSession ? ' · resume' : ''})`,
  });

  const initialProgress = buildInitialEnrichProgress({
    guildMembers,
    name,
    existingSession,
    resolvedCap,
    startedAt,
  });
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

  return {
    sessionId,
    cancelFlag,
    onProgress: createEnrichProgressHandler({
      replyEditor,
      found,
      meta,
      guildMembers,
      startedAt,
      sessionId,
      stopRow,
      cancelFlag,
      lang,
    }),
  };
}

async function executeEnrichScan({
  name,
  meta,
  guildMembers,
  resolvedCap,
  existingSession,
  scan,
}) {
  try {
    const result = await detectAltsViaStronghold(name, {
      targetMeta: meta,
      guildMembers,
      candidateLimit: resolvedCap,
      useScraperApiForCandidates: false,
      onProgress: scan.onProgress,
      cancelFlag: scan.cancelFlag,
      excludeNames: existingSession?.scannedNames ?? [],
      viaWorker: true,
    });
    return { result, error: null };
  } catch (error) {
    return { result: null, error };
  } finally {
    unregisterScan(scan.sessionId);
  }
}

function numericOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCumulativeScanCounts(existingSession, result) {
  const prior = existingSession?.scanStats ?? {};
  const attemptedThisPass = result.attemptedCandidates
    ?? result.scannedCandidates
    ?? 0;
  return {
    scanned: numericOrZero(prior.scanned) + numericOrZero(result.scannedCandidates),
    attempted: numericOrZero(prior.attempted) + numericOrZero(attemptedThisPass),
    failed: numericOrZero(prior.failed) + numericOrZero(result.failedCandidates),
    rateLimitRetries: numericOrZero(prior.rateLimitRetries) + numericOrZero(result.rateLimitRetries),
  };
}

function findNewEnrichAlts(alts, existingCharacters) {
  const knownNames = new Set(
    (existingCharacters || []).map(normalizeNameKey)
  );
  return alts.filter((alt) => !knownNames.has(normalizeNameKey(alt.name)));
}

function buildEnrichSessionProgress({ alts, newAlts, scannedNames, counts, meta }) {
  return {
    allDiscoveredAlts: alts,
    newAlts: newAlts.map((alt) => ({
      name: alt.name,
      classId: alt.classId,
      itemLevel: alt.itemLevel,
    })),
    scannedNames,
    scanStats: {
      ...counts,
      totalAlts: alts.length,
      guildName: meta.guildName,
    },
  };
}

export function buildEnrichCumulativeState({ existingSession, result, existingCharacters, meta }) {
  const alts = mergeAltsByName(existingSession?.allDiscoveredAlts ?? [], result.alts || []);
  const scannedNames = [
    ...(existingSession?.scannedNames ?? []),
    ...(result.scannedNames || []),
  ];
  const counts = buildCumulativeScanCounts(existingSession, result);
  const newAlts = findNewEnrichAlts(alts, existingCharacters);
  return {
    alts,
    newAlts,
    scannedNames,
    ...counts,
    sessionProgress: buildEnrichSessionProgress({
      alts,
      newAlts,
      scannedNames,
      counts,
      meta,
    }),
  };
}

function persistEnrichSession({
  interaction,
  found,
  meta,
  targetIsHidden,
  resolvedCap,
  existingSession,
  sessionProgress,
}) {
  if (existingSession) {
    Object.assign(existingSession, sessionProgress);
    return touchEnrichSession(existingSession.sessionId) || existingSession;
  }
  return createEnrichSession({
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
    ...sessionProgress,
  });
}

function buildCumulativeEnrichResult(result, cumulative) {
  return {
    ...result,
    scannedCandidates: cumulative.scanned,
    checkedCandidates: cumulative.scanned,
    attemptedCandidates: cumulative.attempted,
    failedCandidates: cumulative.failed,
    rateLimitRetries: cumulative.rateLimitRetries,
    alts: cumulative.alts,
    scannedNames: cumulative.scannedNames,
  };
}

function resolveEnrichActionHint({ cumulative, foundType, lang }) {
  if (cumulative.alts.length === 0) return t('dialogue.enrich.noAlts', lang);
  const list = t(`dialogue.broadcast.list.${foundType}`, lang);
  if (cumulative.newAlts.length === 0) {
    return t('dialogue.enrich.allKnown', lang, {
      count: cumulative.alts.length,
      list,
    });
  }
  return t('dialogue.enrich.newAlts', lang, {
    newCount: cumulative.newAlts.length,
    total: cumulative.alts.length,
    list,
  });
}

function buildEnrichResultCard({
  name,
  targetIsHidden,
  meta,
  found,
  existingSession,
  cumulative,
  cumulativeResult,
  session,
  lang,
}) {
  const style = LIST_LABELS[found.type];
  const { embed, state } = buildScanResultEmbed({
    target: {
      name,
      isHidden: targetIsHidden,
      guildName: meta.guildName,
      profileUrl: rosterUrl(name),
    },
    result: cumulativeResult,
    alts: cumulative.alts,
    newAltsSet: new Set(cumulative.newAlts.map((alt) => normalizeNameKey(alt.name))),
    kind: 'enrich',
    contextStyle: { icon: style.icon, color: style.color },
    summaryLine: t('dialogue.enrich.summary', lang, {
      guild: meta.guildName,
      name,
      resumed: existingSession ? t('dialogue.enrich.resumed', lang) : '',
    }),
    actionHint: resolveEnrichActionHint({ cumulative, foundType: found.type, lang }),
    lang,
  });
  const buttonRow = buildScanResultButtons({
    kind: 'enrich',
    sessionId: session.sessionId,
    hasAlts: cumulative.newAlts.length > 0,
    hasRemaining: state.hasRemaining,
    newAltsCount: cumulative.newAlts.length,
    lang,
  });
  return { embed, state, buttonRow };
}

export function resolveEnrichCompletionOutcome(state, altCount) {
  const wasStopped = state.stopReason === 'stopped' || state.stopReason === 'failure-storm';
  if (wasStopped) return altCount === 0 ? 'stopped-no-alts' : 'stopped-with-alts';
  return altCount === 0 ? 'no-alts' : 'completed';
}

function dispatchEnrichCompletionDm({
  interaction,
  replyEditor,
  name,
  meta,
  state,
  cumulative,
  cumulativeResult,
  lang,
}) {
  try {
    const reply = replyEditor.getMessage();
    sendScanCompletionDm({
      user: interaction.user,
      commandLabel: '/la-list enrich',
      scanTargetName: name,
      guildName: meta.guildName,
      channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
      resultMessageUrl: buildResultMessageUrl(interaction, reply),
      outcome: resolveEnrichCompletionOutcome(state, cumulative.alts.length),
      result: cumulativeResult,
      alts: cumulative.newAlts,
      lang,
    }).catch(() => {});
  } catch (err) {
    console.warn('[enrich] DM dispatch failed:', err?.message || err);
  }
}

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

  async function startNewEnrichScan(interaction, name, cap, lang) {
    await startReservedEnrichFlow(interaction, {
      name,
      cap,
      reservationLabel: `/la-list enrich ${name}`,
      cooldownMessage: (wait) => `⏳ ${t('dialogue.enrich.cooldown', lang, { seconds: wait, name })}`,
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
    // Read back once and use it for both the broadcast and the success
    // card's running total · it used to be fetched only when a broadcast
    // was wired up, so the card had no way to say what the entry tracks now.
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
            rosterCharacters: session.newAlts || [],
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
    const state = resolveScanCancelState({
      scan,
      userId: interaction.user.id,
      isPrivileged: isOfficerOrSenior(interaction.user.id),
    });
    const canCancel = await settleScanCancelState({ state, interaction, lang });
    if (!canCancel) return;

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
