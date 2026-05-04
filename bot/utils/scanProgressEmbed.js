/**
 * Generic in-progress embed for long-running stronghold deep scans.
 * Caller owns throttling; this renderer only formats the live state.
 */

import { buildAlertEmbed, AlertSeverity } from './alertEmbed.js';
import { ICONS, buildProgressBar, relativeTime } from './ui.js';
import { getClassEmoji } from '../models/Class.js';

function buildAltsBlock(alts) {
  if (!Array.isArray(alts) || alts.length === 0) return '';
  const visible = alts.slice(0, 12);
  const lines = visible.map((alt) => {
    const cls = alt.className || alt.classId || 'Unknown';
    const classPrefix = getClassEmoji(cls) || cls;
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    const link = `https://lostark.bible/character/NA/${encodeURIComponent(alt.name)}/roster`;
    return `- ${classPrefix} **[${alt.name}](${link})** - \`${ilvl}\``;
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
  const attemptedCandidates = progress.attemptedCandidates ?? progress.scannedCandidates ?? 0;
  const checkedCandidates = progress.checkedCandidates ?? progress.scannedCandidates ?? 0;
  const pct = Math.round((attemptedCandidates / total) * 100);
  const bar = buildProgressBar(pct);
  const startedLine = progress.startedAt
    ? `\n*Started ${relativeTime(progress.startedAt)}*`
    : '';
  const altsBlock = buildAltsBlock(progress.alts);
  const footerParts = [`Backoff ${progress.currentBackoffMs}ms`];
  if ((progress.rateLimitRetries ?? 0) > 0) {
    footerParts.push(`429 retries ${progress.rateLimitRetries}`);
  }
  footerParts.push('15s update interval');

  const statsLine = [
    `Checked **${checkedCandidates}** / ${progress.totalCandidates} candidates`,
    attemptedCandidates > checkedCandidates ? `Attempts **${attemptedCandidates}**` : null,
    `Found **${progress.altsFound}** match`,
    `Failed **${progress.failedCandidates}**`,
  ].filter(Boolean).join(' - ');

  return buildAlertEmbed({
    severity: AlertSeverity.INFO,
    titleIcon: titleIcon || ICONS.search,
    color,
    title,
    description: (
      (subtitle ? `${subtitle}\n\n` : '') +
      `\`${bar}\` ${pct}%\n\n` +
      statsLine +
      altsBlock +
      startedLine
    ).slice(0, 4096),
    footer: footerParts.join(' - '),
    timestamp: false,
  });
}
