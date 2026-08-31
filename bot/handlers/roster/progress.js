/**
 * handlers/roster/progress.js
 * Shared progress-callback + stat formatter for /la-roster deep
 * scans (visible + hidden + continue branches all use the same
 * progress card). Throttles webhook edits to ~one per 15s so the
 * deep scan stays well under Discord's 5-per-5s edit ceiling.
 */

import { COLORS } from '../../utils/ui.js';
import { buildScanProgressEmbed } from '../../utils/scanProgressEmbed.js';
import {
  buildStopButtonRow,
  newScanSessionId,
  registerScan,
  unregisterScan,
} from '../../utils/scanSession.js';
import { t } from '../../services/i18n/index.js';

// Discord webhook edits are rate-limited (5 per 5s). 15s throttle gives
// ~40-60 progress updates over a typical 10-15 minute gentle-mode
// scan; well under the rate-limit ceiling. Tightened from 30s after
// users reported the embed felt frozen between ticks.
const PROGRESS_EDIT_THROTTLE_MS = 15 * 1000;
const PROGRESS_EDIT_FAILURE_LIMIT = 3;

/**
 * Own one active roster scan's cancellation registry and progress UI context.
 * Hidden, visible, and continuation scans differ in data selection, but their
 * session registration, initial card, callback, and cleanup contract is the
 * same and must not drift between entry points.
 */
export function createRosterScanRuntime({
  interaction,
  replyEditor,
  name,
  meta,
  totalMembers,
  label,
  lang = 'en',
}) {
  const startedAtRef = { value: Date.now() };
  const lastEditRef = { value: startedAtRef.value };
  const sessionId = newScanSessionId();
  const cancelFlag = { cancelled: false };
  let closed = false;

  registerScan(sessionId, {
    cancelFlag,
    callerId: interaction.user.id,
    startedAt: startedAtRef.value,
    label,
  });

  const onProgress = makeRosterScanProgressCallback({
    interaction,
    replyEditor,
    name,
    meta,
    totalMembers,
    startedAtRef,
    lastEditRef,
    cancelFlag,
    sessionId,
    lang,
  });

  function buildInitialPayload({
    title,
    subtitle,
    totalCandidates,
    content = '',
    leadingEmbeds = [],
  }) {
    const progressEmbed = buildScanProgressEmbed({
      title,
      subtitle,
      color: COLORS.info,
      lang,
      progress: {
        scannedCandidates: 0,
        totalCandidates,
        altsFound: 0,
        failedCandidates: 0,
        currentBackoffMs: 1500,
        totalMembers,
        startedAt: startedAtRef.value,
      },
    });
    return {
      content,
      embeds: [...leadingEmbeds, progressEmbed],
      components: [buildStopButtonRow(sessionId, { lang })],
    };
  }

  function close() {
    if (closed) return;
    closed = true;
    unregisterScan(sessionId);
  }

  return {
    buildInitialPayload,
    cancelFlag,
    close,
    onProgress,
    sessionId,
    startedAtRef,
  };
}

function abortForProgressEditFailures(cancelFlag) {
  if (!cancelFlag || cancelFlag.cancelled) return;
  cancelFlag.cancelled = true;
  cancelFlag.reason = 'discord-progress-update-failed';
  cancelFlag.label = 'Discord update failed';
  cancelFlag.detail = 'Could not update the scan card repeatedly.';
}

/**
 * Build the onProgress callback shared by hidden-roster + visible-
 * roster deep-scan paths. Wraps Discord editReply with a 15s throttle,
 * preserves the Stop button row, and skips the final 100% tick (the
 * post-scan branch overwrites the embed immediately afterwards so
 * emitting the tick would flicker).
 * @param {object} args - scan session context
 * @returns {Function} progress callback(scanState)
 */
export function makeRosterScanProgressCallback({ interaction, replyEditor, name, meta, totalMembers, startedAtRef, lastEditRef, cancelFlag, sessionId, lang = 'en' }) {
  let progressEditFailures = 0;

  return (progress) => {
    const now = Date.now();
    const isFinal = progress.scannedCandidates >= progress.totalCandidates;
    if (!isFinal && now - lastEditRef.value < PROGRESS_EDIT_THROTTLE_MS) {
      return;
    }
    lastEditRef.value = now;
    if (isFinal) return;
    const buttonRow = cancelFlag?.cancelled
      ? buildStopButtonRow(sessionId, { disabled: true, label: t('common.actions.stopping', lang), lang })
      : buildStopButtonRow(sessionId, { lang });
    const edit = replyEditor?.edit
      ? replyEditor.edit.bind(replyEditor)
      : interaction.editReply.bind(interaction);
    edit({
      content: '',
      embeds: [buildScanProgressEmbed({
        title: t('dialogue.scan.progress', lang, { name }),
        subtitle: totalMembers
          ? t('dialogue.scan.guildMembers', lang, { guild: meta.guildName, count: totalMembers })
          : t('dialogue.scan.guild', lang, { guild: meta.guildName }),
        color: COLORS.info,
        progress: { ...progress, totalMembers, startedAt: startedAtRef.value },
        lang,
      })],
      components: [buttonRow],
    }).then(() => {
      progressEditFailures = 0;
    }).catch((err) => {
      progressEditFailures += 1;
      console.warn('[roster] Progress edit failed:', err?.message || err);
      if (progressEditFailures >= PROGRESS_EDIT_FAILURE_LIMIT) {
        abortForProgressEditFailures(cancelFlag);
      }
    });
  };
}

/**
 * Format the Stronghold deep-scan result into a short stats line
 * (candidates scanned · alts found · failure rate). Used by both the
 * visible + hidden deep-scan branches to print a consistent summary.
 * @param {object} altResult - the detectAltsViaStronghold return
 * @returns {string} the formatted stats line for the result embed
 */
export function formatDeepScanStats(altResult, lang = 'en') {
  if (!altResult) return '';

  const checked = altResult.checkedCandidates ?? altResult.scannedCandidates ?? 0;
  const attempted = altResult.attemptedCandidates ?? altResult.scannedCandidates ?? 0;
  const optionalMetrics = [
    { visible: attempted > checked, key: 'attempted', count: attempted },
    { visible: (altResult.skippedCandidates ?? 0) > 0, key: 'skipped', count: altResult.skippedCandidates },
    { visible: (altResult.failedCandidates ?? 0) > 0, key: 'failed', count: altResult.failedCandidates },
    { visible: Boolean(altResult.concurrency), key: 'concurrency', count: altResult.concurrency },
  ];
  const parts = [
    t('dialogue.scan.stats.checked', lang, { count: checked }),
    ...optionalMetrics
      .filter(({ visible }) => visible)
      .map(({ key, count }) => t(`dialogue.scan.stats.${key}`, lang, { count })),
    t('dialogue.scan.stats.scraper', lang, {
      state: t(`dialogue.scan.stats.${altResult.usedScraperApiForCandidates ? 'on' : 'off'}`, lang),
    }),
  ];
  return parts.join(' · ');
}
