/**
 * Pure scan state helpers and execution pipeline for /la-list enrich.
 * Keeps target lookup, Stronghold progress throttling, cumulative state
 * merging, and result card building separate from Discord interaction routing.
 */

import config from '../../../config.js';
import { MIN_TRACKED_ITEM_LEVEL } from '../../../config/itemLevelThreshold.js';
import {
  fetchCharacterMeta,
  fetchGuildMembers,
  detectAltsViaStronghold,
  buildRosterCharacters,
  saveRosterSnapshotsBestEffort,
} from '../../../services/roster/index.js';
import { normalizeNameKey } from '../../../utils/names.js';
import { buildAlertEmbed, NoticeKind } from '../../../utils/alertEmbed.js';
import { replyAlert } from '../../../utils/interactionReplies.js';
import { t } from '../../../services/i18n/index.js';
import {
  buildScanResultEmbed,
  buildScanResultButtons,
} from '../../../utils/scanResultEmbed.js';
import {
  findEntryByName,
  LIST_LABELS,
} from './data.js';
import {
  createEnrichSession,
  touchEnrichSession,
} from './state.js';
import { buildEnrichProgressEmbed } from './ui.js';
import {
  buildStopButtonRow,
  newScanSessionId,
  registerScan,
  unregisterScan,
} from '../../../utils/scanSession.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../../utils/scanCompletionDm.js';
import { SCAN_ABORT_REASONS } from '../../../utils/scanAbortReasons.js';
import { mergeAltsByName } from '../../../utils/alts.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import {
  PROGRESS_EDIT_THROTTLE_MS,
  PROGRESS_EDIT_FAILURE_LIMIT,
} from '../../roster/progress.js';

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

/**
 * Determine whether a stop button click can cancel an active scan.
 * @param {{scan: object|null, userId: string, isPrivileged: boolean}} context
 * @returns {'finished'|'restricted'|'already-stopping'|'ready'}
 */
export function resolveScanCancelState(context) {
  return SCAN_CANCEL_STATE_RULES.find(({ matches }) => matches(context))?.state || 'ready';
}

/**
 * Reply to an invalid stop click or allow cancellation when ready.
 * @param {{state: string, interaction: object, lang: string}} options
 * @returns {Promise<boolean>} true when the caller may proceed with cancelling
 */
export async function settleScanCancelState({ state, interaction, lang }) {
  switch (state) {
    case 'finished':
      await replyAlert(interaction, {
        kind: NoticeKind.EXPIRED,
        ...t('dialogue.enrich.scanFinished', lang),
      });
      return false;
    case 'restricted':
      await replyAlert(interaction, {
        kind: NoticeKind.GUARD,
        ...t('dialogue.enrich.stopRestricted', lang),
      });
      return false;
    case 'already-stopping':
      await replyAlert(interaction, {
        kind: NoticeKind.PROGRESS,
        ...t('dialogue.enrich.alreadyStopping', lang),
      });
      return false;
    default:
      return true;
  }
}

// Why an enrich run could not start or finish, by its dialogue key: a name
// that is not there is empty, Bible trouble is busy, a missing guild leaves
// nothing to scan, and a detector with no result is a failure.
const ENRICH_ERROR_KINDS = Object.freeze({
  'dialogue.enrich.profileMissing': NoticeKind.EMPTY,
  'dialogue.enrich.noEntry': NoticeKind.EMPTY,
  'dialogue.enrich.metaMissing': NoticeKind.BUSY,
  'dialogue.enrich.guildUnavailable': NoticeKind.BUSY,
  'dialogue.enrich.scanStopped': NoticeKind.BUSY,
  'dialogue.enrich.noGuild': NoticeKind.EMPTY,
  'dialogue.enrich.scanFailed': NoticeKind.FAILURE,
});

/**
 * Edit the long-running reply with an enrich error notice mapped by key.
 * @param {object} replyEditor
 * @param {string} key
 * @param {string} lang
 * @param {object} [values={}]
 * @param {{clearContent?: boolean}} [options={}]
 * @returns {Promise<void>}
 */
export async function editEnrichError(replyEditor, key, lang, values = {}, { clearContent = false } = {}) {
  const payload = {
    embeds: [buildAlertEmbed({
      kind: ENRICH_ERROR_KINDS[key] ?? NoticeKind.FAILURE,
      ...t(key, lang, values),
    })],
    components: [],
  };
  if (clearContent) payload.content = '';
  await replyEditor.edit(payload);
}

/**
 * Whether the entry's roster is hidden, probing lostark.bible once per scan
 * session. The probed roster is saved as snapshots, since list cards read item
 * level and combat score from them.
 * @param {object} args - name, existingSession, lang and replyEditor of the scan;
 *   `buildRosterCharactersFn` and `saveSnapshotsFn` are injectable for tests
 * @returns {Promise<{ok: boolean, targetIsHidden?: boolean}>} `ok: false` after
 *   the missing-profile notice was shown
 */
export async function resolveEnrichTargetVisibility({
  name, existingSession, lang, replyEditor,
  buildRosterCharactersFn = buildRosterCharacters,
  saveSnapshotsFn = saveRosterSnapshotsBestEffort,
}) {
  if (existingSession?.targetIsHidden !== undefined) {
    return { ok: true, targetIsHidden: existingSession.targetIsHidden };
  }
  const probe = await buildRosterCharactersFn(name, {
    hiddenRosterFallback: true,
    viaWorker: true,
  });
  if (probe.hasValidRoster) {
    await saveSnapshotsFn(probe.rosterCharacters, name, { label: '[enrich]' });
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

/**
 * Load the list entry, roster visibility, character meta, and guild roster
 * needed before starting a Stronghold enrich scan.
 * @param {object} options
 * @returns {Promise<{found: object, meta: object, guildMembers: object[], targetIsHidden: boolean}|null>}
 */
export async function loadEnrichTarget({ name, guildId, existingSession, lang, replyEditor }) {
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
  if (guildMembers?.length > 0) {
    return { found, meta, guildMembers, targetIsHidden: visibility.targetIsHidden };
  }
  await editEnrichError(replyEditor, 'dialogue.enrich.guildUnavailable', lang, { name });
  return null;
}

/**
 * Build the initial progress counter object for the first progress embed.
 * @param {object} options
 * @returns {object}
 */
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
    && member.ilvl >= MIN_TRACKED_ITEM_LEVEL
    && !excludedNames.has(normalizeNameKey(member.name))
  )).length;
  const passLimit = resolvedCap || passEligible;
  return {
    attemptedCandidates: 0,
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
    const isFinal = progress.attemptedCandidates >= progress.totalCandidates;
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
      Object.assign(cancelFlag, { cancelled: true, reason: SCAN_ABORT_REASONS.discordProgressUpdateFailed });
    });
  };
}

/**
 * Register a scan cancellation session and render the initial progress embed.
 * @param {object} options
 * @returns {Promise<{sessionId: string, cancelFlag: {cancelled: boolean}, onProgress: Function}>}
 */
export async function beginEnrichScan({
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

/**
 * Run Stronghold alt detection for the enrich target and always unregister
 * the active scan cancellation handle afterwards.
 * @param {object} options
 * @returns {Promise<{result: object|null, error: Error|null}>}
 */
export async function executeEnrichScan({
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
  const attemptedThisPass = result.attemptedCandidates ?? 0;
  return {
    scanned: numericOrZero(prior.scanned) + numericOrZero(result.checkedCandidates),
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

/**
 * Merge a pass's discovered alts and counters onto any prior Continue session.
 * @param {object} options
 * @returns {object}
 */
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

/**
 * Create or update the in-memory enrich confirmation session for this scan.
 * @param {object} options
 * @returns {object}
 */
export function persistEnrichSession({
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

/**
 * Overlay cumulative counts and discovered alts onto the latest scan result.
 * @param {object} result
 * @param {object} cumulative
 * @returns {object}
 */
export function buildCumulativeEnrichResult(result, cumulative) {
  return {
    ...result,
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

/**
 * Render the post-scan enrich embed and action button row.
 * @param {object} options
 * @returns {{embed: object, state: object, buttonRow: object|null}}
 */
export function buildEnrichResultCard({
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

/**
 * Map post-scan state and discovered alt count to a DM outcome key.
 * @param {{stopReason?: string}} state
 * @param {number} altCount
 * @returns {'stopped-no-alts'|'stopped-with-alts'|'no-alts'|'completed'}
 */
export function resolveEnrichCompletionOutcome(state, altCount) {
  const wasStopped = state.stopReason === 'stopped' || state.stopReason === 'failure-storm';
  if (wasStopped) return altCount === 0 ? 'stopped-no-alts' : 'stopped-with-alts';
  return altCount === 0 ? 'no-alts' : 'completed';
}

/**
 * Send a best-effort completion DM to the scan requester with a jump link.
 * @param {object} options
 * @returns {void}
 */
export function dispatchEnrichCompletionDm({
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
