/**
 * scanProgressEmbed.js
 *
 * Generic in-progress embed for long-running stronghold deep scans.
 * Used by /la-list enrich and /la-roster deep:true so the officer can
 * watch the worker through a 10-15 minute candidate fan-out instead of
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
/**
 * Render the live "matches so far" block. Cap at 12 lines so the
 * description stays well under Discord's 4096-char cap even when
 * combined with subtitle + progress bar + stats.
 *
 * Each line: `• [<Name>](<roster-link>) · <Class> · \`<ilvl>\``
 *
 * Names are linked to the lostark.bible roster page so an officer
 * can click straight through to verify the match without copying
 * the name into a separate /la-roster lookup.
 */
function buildAltsBlock(alts) {
  if (!Array.isArray(alts) || alts.length === 0) return '';
  const visible = alts.slice(0, 12);
  const lines = visible.map((alt) => {
    const cls = alt.className || alt.classId || 'Unknown';
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    const link = `https://lostark.bible/character/NA/${encodeURIComponent(alt.name)}/roster`;
    return `• **[${alt.name}](${link})** · ${cls} · \`${ilvl}\``;
  });
  const extra = alts.length > visible.length
    ? `\n*... and ${alts.length - visible.length} more*`
    : '';
  return `\n\n**Matches so far (${alts.length}):**\n${lines.join('\n')}${extra}`;
}

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
  // Discord renders <t:UNIX:R> tokens only inside message content +
  // embed description, NOT inside footers or titles. Putting "started
  // X ago" in the description keeps the relative-time ticker live; the
  // footer is reserved for static config (backoff value).
  const startedLine = progress.startedAt
    ? `\n*Started ${relativeTime(progress.startedAt)}*`
    : '';
  const altsBlock = buildAltsBlock(progress.alts);

  return buildAlertEmbed({
    severity: AlertSeverity.INFO,
    titleIcon: titleIcon || ICONS.search,
    color,
    title,
    description: (
      (subtitle ? `${subtitle}\n\n` : '') +
      `\`${bar}\` ${pct}%\n\n` +
      `Scanned **${progress.scannedCandidates}** / ${progress.totalCandidates} candidates · ` +
      `Found **${progress.altsFound}** match · ` +
      `Failed **${progress.failedCandidates}**` +
      altsBlock +
      startedLine
    ).slice(0, 4096),
    footer: `Backoff ${progress.currentBackoffMs}ms · 15s update interval`,
    timestamp: false,
  });
}
