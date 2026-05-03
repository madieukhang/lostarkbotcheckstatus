/**
 * scanProgressEmbed.js
 *
 * Generic in-progress embed for long-running stronghold deep scans.
 * Used by /la-list enrich and /la-roster deep:true so the officer can
 * watch the worker through a 5-7 minute candidate fan-out instead of
 * staring at a static "Running scan..." line.
 *
 * Caller is responsible for throttling editReply calls; Discord webhook
 * edits are rate-limited to 5 per 5s. The detector emits onProgress at a
 * per-25-candidate cadence so a 30s throttle gives ~10-14 updates over a
 * typical scan, well under the rate-limit ceiling.
 */

import { buildAlertEmbed, AlertSeverity } from './alertEmbed.js';
import { ICONS, buildProgressBar, relativeTime } from './ui.js';

/**
 * @typedef ScanProgress
 * @property {number} scannedCandidates
 * @property {number} totalCandidates
 * @property {number} altsFound
 * @property {number} failedCandidates
 * @property {number} currentBackoffMs
 * @property {number} [startedAt] - epoch ms; renders the "started <relative>" hint when present
 */

/**
 * @param {Object} options
 * @param {string} options.title - Embed title (e.g. "Stronghold scan in progress · Ainslinn").
 * @param {string} [options.subtitle] - Optional first paragraph (e.g. "Guild **Bullet Shell** (820 members)").
 * @param {number} [options.color] - Override embed color; defaults to AlertSeverity.INFO blurple.
 * @param {string} [options.titleIcon] - Override the leading icon glyph; defaults to the search magnifier.
 * @param {ScanProgress} options.progress
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildScanProgressEmbed({
  title,
  subtitle,
  color,
  titleIcon,
  progress,
}) {
  const total = Math.max(1, progress.totalCandidates || 1);
  const pct = Math.round((progress.scannedCandidates / total) * 100);
  const bar = buildProgressBar(pct);
  const startedLine = progress.startedAt
    ? ` · started ${relativeTime(progress.startedAt)}`
    : '';

  return buildAlertEmbed({
    severity: AlertSeverity.INFO,
    titleIcon: titleIcon || ICONS.search,
    color,
    title,
    description:
      (subtitle ? `${subtitle}\n\n` : '') +
      `\`${bar}\` ${pct}%\n\n` +
      `Scanned **${progress.scannedCandidates}** / ${progress.totalCandidates} candidates · ` +
      `Found **${progress.altsFound}** match · ` +
      `Failed **${progress.failedCandidates}**`,
    footer: `Backoff ${progress.currentBackoffMs}ms${startedLine}`,
    timestamp: false,
  });
}
