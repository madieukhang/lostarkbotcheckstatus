/**
 * Generic in-progress embed for long-running stronghold deep scans.
 * Caller owns throttling; this renderer only formats the live state.
 */

import { buildAlertEmbed, AlertSeverity } from './alertEmbed.js';
import { truncateInlineText } from './discordText.js';
import { rosterUrl } from './rosterLink.js';
import { ICONS, buildProgressBar, relativeTime } from './ui.js';
import { getClassEmoji } from '../models/Class.js';
import { t } from '../services/i18n/index.js';

function buildAltsBlock(alts, lang) {
  if (!Array.isArray(alts) || alts.length === 0) return '';
  const visible = alts.slice(0, 12);
  const lines = visible.map((alt) => {
    const cls = alt.className || alt.classId || t('dialogue.scan.progressUi.unknown', lang);
    const classPrefix = getClassEmoji(cls) || cls;
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    const link = rosterUrl(alt.name);
    return `- ${classPrefix} **[${alt.name}](${link})** - \`${ilvl}\``;
  });
  const extra = alts.length > visible.length
    ? `\n*${t('dialogue.scan.progressUi.more', lang, { count: alts.length - visible.length })}*`
    : '';
  return `\n\n**${t('dialogue.scan.progressUi.matches', lang, { count: alts.length })}**\n${lines.join('\n')}${extra}`;
}

export function buildScanProgressEmbed({
  title,
  subtitle,
  color,
  titleIcon,
  progress,
  lang = 'en',
}) {
  const total = Math.max(1, progress.totalCandidates || 1);
  const attemptedCandidates = progress.attemptedCandidates ?? progress.scannedCandidates ?? 0;
  const checkedCandidates = progress.checkedCandidates ?? progress.scannedCandidates ?? 0;
  const pct = Math.round((attemptedCandidates / total) * 100);
  const bar = buildProgressBar(pct);
  const startedLine = progress.startedAt
    ? `\n*${t('dialogue.scan.progressUi.started', lang, { time: relativeTime(progress.startedAt) })}*`
    : '';
  const altsBlock = buildAltsBlock(progress.alts, lang);
  const failureReason = truncateInlineText(progress.lastFailureReason, 120);
  const failureLine = failureReason && (progress.failedCandidates ?? 0) > 0
    ? `\n${t('dialogue.scan.progressUi.lastError', lang, { error: failureReason })}`
    : '';
  const footerParts = [t('dialogue.scan.progressUi.backoff', lang, { ms: progress.currentBackoffMs })];
  if ((progress.rateLimitRetries ?? 0) > 0) {
    footerParts.push(t('dialogue.scan.progressUi.retries', lang, { count: progress.rateLimitRetries }));
  }
  footerParts.push(t('dialogue.scan.progressUi.interval', lang));

  const statsLine = [
    t('dialogue.scan.progressUi.checked', lang, { checked: checkedCandidates, total: progress.totalCandidates }),
    attemptedCandidates > checkedCandidates ? t('dialogue.scan.progressUi.attempts', lang, { count: attemptedCandidates }) : null,
    t('dialogue.scan.progressUi.found', lang, { count: progress.altsFound }),
    t('dialogue.scan.progressUi.failed', lang, { count: progress.failedCandidates }),
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
      failureLine +
      altsBlock +
      startedLine
    ).slice(0, 4096),
    footer: footerParts.join(' - '),
    timestamp: false,
    lang,
  });
}
