import { COLORS } from '../../utils/ui.js';
import { buildScanProgressEmbed } from '../../utils/scanProgressEmbed.js';
import { buildStopButtonRow } from '../../utils/scanSession.js';

// Discord webhook edits are rate-limited (5 per 5s). 15s throttle gives
// ~40-60 progress updates over a typical 10-15 minute gentle-mode
// scan; well under the rate-limit ceiling. Tightened from 30s after
// users reported the embed felt frozen between ticks.
const PROGRESS_EDIT_THROTTLE_MS = 15 * 1000;
const PROGRESS_EDIT_FAILURE_LIMIT = 3;

function abortForProgressEditFailures(cancelFlag) {
  if (!cancelFlag || cancelFlag.cancelled) return;
  cancelFlag.cancelled = true;
  cancelFlag.reason = 'discord-progress-update-failed';
  cancelFlag.label = 'Discord update failed';
  cancelFlag.detail = 'Could not update the scan card repeatedly.';
}

/**
 * Build the onProgress callback used by both the hidden-roster and the
 * visible-roster deep-scan paths. Wraps Discord editReply with a 15s
 * throttle, preserves the Stop button row, and skips the final 100%
 * tick because the post-scan branch overwrites the embed immediately
 * afterwards (would flicker for ms).
 */
export function makeRosterScanProgressCallback({ interaction, replyEditor, name, meta, totalMembers, startedAtRef, lastEditRef, cancelFlag, sessionId }) {
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
      ? buildStopButtonRow(sessionId, { disabled: true, label: 'Stopping...' })
      : buildStopButtonRow(sessionId);
    const edit = replyEditor?.edit
      ? replyEditor.edit.bind(replyEditor)
      : interaction.editReply.bind(interaction);
    edit({
      content: '',
      embeds: [buildScanProgressEmbed({
        title: `Stronghold scan in progress · ${name}`,
        subtitle: `Guild **${meta.guildName}**` +
          (totalMembers ? ` (${totalMembers} members)` : ''),
        color: COLORS.info,
        progress: { ...progress, totalMembers, startedAt: startedAtRef.value },
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

export function formatDeepScanStats(altResult) {
  if (!altResult) return '';

  const checked = altResult.checkedCandidates ?? altResult.scannedCandidates ?? 0;
  const attempted = altResult.attemptedCandidates ?? altResult.scannedCandidates ?? 0;
  const parts = [`checked ${checked}`];
  if (attempted > checked) {
    parts.push(`attempted ${attempted}`);
  }
  if ((altResult.skippedCandidates ?? 0) > 0) {
    parts.push(`skipped ${altResult.skippedCandidates} by limit`);
  }
  if ((altResult.failedCandidates ?? 0) > 0) {
    parts.push(`failed ${altResult.failedCandidates}`);
  }
  if (altResult.concurrency) {
    parts.push(`concurrency ${altResult.concurrency}`);
  }
  parts.push(`ScraperAPI ${altResult.usedScraperApiForCandidates ? 'on' : 'off'}`);
  return parts.join(' · ');
}
