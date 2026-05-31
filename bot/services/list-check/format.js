import { getClassEmoji, isSupportClass } from '../../models/Class.js';

/**
 * Pick the alt list to display for an item, in this priority order:
 *   1. Blacklist > Whitelist > Watchlist > Trusted entry's allCharacters
 *      (the entry was recorded with its account roster snapshot).
 *   2. `item.discoveredAlts` from the online enrichment branch
 *      (worker-online buildRosterCharacters; only when roster was
 *      publicly visible).
 * Filters out the item's own name and dedupes case-insensitively.
 */
function pickAltsForDisplay(item) {
  const sourceEntry = item.blackEntry || item.whiteEntry || item.watchEntry || item.trustedEntry;
  const raw = (sourceEntry?.allCharacters && sourceEntry.allCharacters.length > 0)
    ? sourceEntry.allCharacters
    : (Array.isArray(item.discoveredAlts) ? item.discoveredAlts : []);
  if (raw.length === 0) return [];
  const seen = new Set([item.name.toLowerCase()]);
  const out = [];
  for (const n of raw) {
    const trimmed = String(n || '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Build the per-character line for an OCR check result.
 *
 * Layout:
 *   [status-icon] [class-icon] **Name** · `ilvl` · CP nnn
 *      ↳ via Other · reason · [raid]            (only when flagged)
 *      ↳ via Other · trusted                    (only when trusted via roster)
 *      ↳ alts: A, B, C +N more                  (when alts are known)
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
    ? ` · \`${item.snapItemLevel.toFixed(2)}\`${item.snapCombatScore ? ` · CP \`${item.snapCombatScore}\`` : ''}`
    : '';

  const trustedTag = item.trustedEntry && (isBlack || isWhite || isWatch) ? ' 🛡️' : '';

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

  // Alts line · capped at 3 visible with `+N more` overflow so the
  // 4096-char embed description stays in budget even with 8 names.
  // Hidden / missing rosters skip silently because discoveredAlts is
  // only populated when rosterVisibility === 'visible'.
  const alts = pickAltsForDisplay(item);
  if (alts.length > 0) {
    const visible = alts.slice(0, 3);
    const tail = alts.length > visible.length ? ` *+${alts.length - visible.length} more*` : '';
    branches.push(`   ↳ alts: ${visible.join(', ')}${tail}`);
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
    const directTag = isVia ? '' : ' · trusted';
    // Trusted-only branch reuses the same `branches` block built above
    // so the alts line (if any) renders. Prepend the via-trusted note
    // so it shows above alts in the same sub-list.
    const trustedBranches = [];
    if (isVia) trustedBranches.push(`   ↳ via **${item.trustedEntry.name}** · trusted`);
    for (const b of branches) trustedBranches.push(b);
    const trustedBlock = trustedBranches.length > 0 ? `\n${trustedBranches.join('\n')}` : '';
    return {
      line: `🛡️ ${classPrefix}**${item.name}**${statSuffix}${directTag}${trustedBlock}`,
      priority: 2,
    };
  }
  return { line: `❓ ${classPrefix}${item.name}${statSuffix}${branchBlock}`, priority: 3 };
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
