import { getClassEmoji, isSupportClass } from '../../models/Class.js';

/**
 * Build the per-character line for an OCR check result.
 *
 * Layout:
 *   [status-icon] [class-icon] **Name** · `ilvl` · CP nnn
 *      ↳ via Other · reason · [raid]            (only when flagged)
 *      ↳ via Other · trusted                    (only when trusted via roster)
 *
 * @returns {{ line: string, priority: number }}
 */
function formatResultLine(item) {
  const isBlack = Boolean(item.blackEntry);
  const isWhite = Boolean(item.whiteEntry);
  const isWatch = Boolean(item.watchEntry);

  const classPrefix = item.snapClassName
    ? (getClassEmoji(item.snapClassName) || item.snapClassName) + ' '
    : '';

  const statSuffix = item.snapItemLevel > 0
    ? ` · \`${item.snapItemLevel.toFixed(2)}\`${item.snapCombatScore ? ` · CP ${item.snapCombatScore}` : ''}`
    : '';

  const trustedTag = item.trustedEntry && (isBlack || isWhite || isWatch) ? ' 💚' : '';

  const branches = [];
  for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
    if (!entry) continue;
    const isRosterMatch = entry.name.toLowerCase() !== item.name.toLowerCase();
    const parts = [];
    if (isRosterMatch) parts.push(`via **${entry.name}**`);
    if (entry.reason?.trim()) parts.push(`*${entry.reason.trim()}*`);
    if (entry.raid?.trim()) parts.push(`[${entry.raid.trim()}]`);
    if (parts.length > 0) branches.push(`   ↳ ${parts.join(' · ')}`);
  }

  const branchBlock = branches.length > 0 ? `\n${branches.join('\n')}` : '';

  if (isBlack) {
    const scopeTag = item.blackEntry?.scope === 'server' ? ' (Local)' : '';
    return {
      line: `⛔ ${classPrefix}**${item.name}**${scopeTag}${trustedTag}${statSuffix}${branchBlock}`,
      priority: 0,
    };
  }
  if (isWatch) {
    return {
      line: `⚠️ ${classPrefix}**${item.name}**${trustedTag}${statSuffix}${branchBlock}`,
      priority: 1,
    };
  }
  if (isWhite) {
    return {
      line: `✅ ${classPrefix}**${item.name}**${trustedTag}${statSuffix}${branchBlock}`,
      priority: 2,
    };
  }
  if (item.trustedEntry) {
    const isVia = item.trustedEntry.name.toLowerCase() !== item.name.toLowerCase();
    const viaBranch = isVia ? `\n   ↳ via **${item.trustedEntry.name}** · trusted` : '';
    const directTag = isVia ? '' : ' · trusted';
    return {
      line: `💚 ${classPrefix}**${item.name}**${statSuffix}${directTag}${viaBranch}`,
      priority: 2,
    };
  }
  return { line: `❓ ${classPrefix}${item.name}${statSuffix}`, priority: 3 };
}

/**
 * Format check results into Discord-ready text lines.
 * Sorted by priority: blacklist, watchlist, whitelist/trusted, not listed.
 *
 * @param {Array<object>} results - Output from checkNamesAgainstLists
 * @returns {string[]} Formatted lines sorted by display priority
 */
export function formatCheckResults(results) {
  const formatted = results.map((item) => ({ ...formatResultLine(item), item }));

  formatted.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aSupport = isSupportClass(a.item.snapClassName) ? 1 : 0;
    const bSupport = isSupportClass(b.item.snapClassName) ? 1 : 0;
    if (aSupport !== bSupport) return aSupport - bSupport;
    return 0;
  });

  return formatted.map((f) => f.line);
}
