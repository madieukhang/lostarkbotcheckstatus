import { getClassEmoji, isSupportClass } from '../../models/Class.js';
import { t } from '../i18n/index.js';
import { groupListCheckResults } from './displayGroups.js';
import { didListCheckNameChange } from './matchResolution.js';

function normalizeName(value) {
  return String(value || '').trim().toLowerCase();
}

function formatMatchContext(item, entry, listType, lang) {
  const detail = item.matchDetails?.[listType];
  if (detail?.kind === 'roster') {
    const matchedName = String(detail.matchedName || entry.name || '').trim();
    if (normalizeName(matchedName) === normalizeName(entry.name)) {
      return t('dialogue.check.format.rosterVia', lang, { name: matchedName });
    }
    return t('dialogue.check.format.rosterEntry', lang, {
      name: matchedName,
      entry: entry.name,
    });
  }
  if (normalizeName(entry.name) !== normalizeName(item.name)) {
    return t('dialogue.check.format.via', lang, { name: entry.name });
  }
  return '';
}

/**
 * Pick the alt list to display for an item, in this priority order:
 *   1. Blacklist > Whitelist > Watchlist > Trusted entry's allCharacters
 *      (the entry was recorded with its account roster snapshot).
 *   2. `item.discoveredAlts` from the online enrichment branch
 *      (worker-online buildRosterCharacters; only when roster was
 *      publicly visible).
 * Filters out the item's own name and dedupes case-insensitively.
 */
function pickAltsForDisplay(item, excludedNames = [item.name]) {
  const sourceEntry = item.blackEntry || item.whiteEntry || item.watchEntry || item.trustedEntry;
  const raw = (sourceEntry?.allCharacters && sourceEntry.allCharacters.length > 0)
    ? sourceEntry.allCharacters
    : (Array.isArray(item.discoveredAlts) ? item.discoveredAlts : []);
  if (raw.length === 0) return [];
  const seen = new Set(excludedNames.map(normalizeName).filter(Boolean));
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

function getClassPrefix(item) {
  return item.snapClassName
    ? (getClassEmoji(item.snapClassName) || item.snapClassName) + ' '
    : '';
}

function getStatSuffix(item) {
  return item.snapItemLevel > 0
    ? ` · \`${item.snapItemLevel.toFixed(2)}\`${item.snapCombatScore ? ` · CP \`${item.snapCombatScore}\`` : ''}`
    : '';
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
function formatResultLine(item, lang = 'en') {
  const isBlack = Boolean(item.blackEntry);
  const isWhite = Boolean(item.whiteEntry);
  const isWatch = Boolean(item.watchEntry);

  const classPrefix = getClassPrefix(item);
  const statSuffix = getStatSuffix(item);

  const trustedTag = item.trustedEntry && (isBlack || isWhite || isWatch) ? ' 🛡️' : '';

  const branches = [];
  if (didListCheckNameChange(item)) {
    const correctionKey = item.inputSource === 'ocr' ? 'correctedOcr' : 'correctedText';
    branches.push(`   ↳ ${t(`dialogue.check.format.${correctionKey}`, lang, {
      input: item.inputName,
      name: item.name,
    })}`);
  }
  for (const [listType, entry] of [
    ['black', item.blackEntry],
    ['white', item.whiteEntry],
    ['watch', item.watchEntry],
  ]) {
    if (!entry) continue;
    const parts = [];
    const matchContext = formatMatchContext(item, entry, listType, lang);
    if (matchContext) parts.push(matchContext);
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
    const tail = alts.length > visible.length ? ` *${t('dialogue.check.format.more', lang, { count: alts.length - visible.length })}*` : '';
    branches.push(`   ↳ ${t('dialogue.check.format.alts', lang)}: ${visible.join(', ')}${tail}`);
  }

  const branchBlock = branches.length > 0 ? `\n${branches.join('\n')}` : '';

  if (isBlack) {
    const scopeTag = item.blackEntry?.scope === 'server' ? ` (${t('dialogue.check.format.local', lang)})` : '';
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
    const trustedContext = formatMatchContext(item, item.trustedEntry, 'trusted', lang);
    const directTag = trustedContext ? '' : ` · ${t('dialogue.check.format.trusted', lang)}`;
    // Trusted-only branch reuses the same `branches` block built above
    // so the alts line (if any) renders. Prepend the via-trusted note
    // so it shows above alts in the same sub-list.
    const trustedBranches = [];
    if (trustedContext) trustedBranches.push(`   ↳ ${trustedContext} · ${t('dialogue.check.format.trusted', lang)}`);
    for (const b of branches) trustedBranches.push(b);
    const trustedBlock = trustedBranches.length > 0 ? `\n${trustedBranches.join('\n')}` : '';
    return {
      line: `🛡️ ${classPrefix}**${item.name}**${statSuffix}${directTag}${trustedBlock}`,
      priority: 2,
    };
  }
  return { line: `❓ ${classPrefix}${item.name}${statSuffix}${branchBlock}`, priority: 3 };
}

function formatRosterGroupLine(group, lang = 'en') {
  const item = group.items[0];
  const isBlack = group.status === 'black';
  const isWatch = group.status === 'watch';
  const isWhite = group.status === 'white';
  const isTrusted = group.status === 'trusted';
  const icon = isBlack ? '⛔' : isWatch ? '⚠️' : isWhite ? '✅' : '🛡️';
  const scopeTag = isBlack && item.blackEntry?.scope === 'server'
    ? ` (${t('dialogue.check.format.local', lang)})`
    : '';
  const trustedTag = !isTrusted && item.trustedEntry ? ' 🛡️' : '';
  const entryContext = group.entry?.name
    ? ` · ${t('dialogue.check.format.via', lang, { name: group.entry.name })}`
    : '';
  const trustedContext = isTrusted ? ` · ${t('dialogue.check.format.trusted', lang)}` : '';
  const heading = `${icon} **${t('dialogue.check.format.sameRoster', lang, { count: group.items.length })}**${scopeTag}${trustedTag}${entryContext}${trustedContext}`;
  const branches = [];

  const photographed = group.items.map((member) => (
    `${getClassPrefix(member)}**${member.name}**${getStatSuffix(member)}`
  ));
  for (let index = 0; index < photographed.length; index += 2) {
    const label = index === 0 ? `${t('dialogue.check.format.inImage', lang)}: ` : '';
    branches.push(`   ↳ ${label}${photographed.slice(index, index + 2).join(' · ')}`);
  }

  for (const member of group.items) {
    if (!didListCheckNameChange(member)) continue;
    const correctionKey = member.inputSource === 'ocr' ? 'correctedOcr' : 'correctedText';
    branches.push(`   ↳ ${t(`dialogue.check.format.${correctionKey}`, lang, {
      input: member.inputName,
      name: member.name,
    })}`);
  }

  for (const [listType, entry] of [
    ['black', item.blackEntry],
    ['white', item.whiteEntry],
    ['watch', item.watchEntry],
  ]) {
    if (!entry) continue;
    const parts = [];
    if (listType !== group.status) {
      const matchContext = formatMatchContext(item, entry, listType, lang);
      if (matchContext) parts.push(matchContext);
    }
    if (entry.reason?.trim()) parts.push(`*${entry.reason.trim()}*`);
    if (entry.raid?.trim()) parts.push(`[${entry.raid.trim()}]`);
    if (parts.length > 0) branches.push(`   ↳ ${parts.join(' · ')}`);
  }

  const alts = pickAltsForDisplay(item, group.items.map((member) => member.name));
  if (alts.length > 0) {
    const visible = alts.slice(0, 3);
    const tail = alts.length > visible.length
      ? ` *${t('dialogue.check.format.more', lang, { count: alts.length - visible.length })}*`
      : '';
    branches.push(`   ↳ ${t('dialogue.check.format.alts', lang)}: ${visible.join(', ')}${tail}`);
  }

  return {
    line: `${heading}\n${branches.join('\n')}`,
    priority: group.priority,
    item,
  };
}

/**
 * Format check results into Discord-ready text lines.
 * Sorted by priority: blacklist, watchlist, whitelist/trusted, not listed.
 *
 * @param {Array<object>} results - Output from checkNamesAgainstLists
 * @returns {string[]} Formatted lines sorted by display priority
 */
export function formatCheckResults(results, lang = 'en') {
  const formatted = groupListCheckResults(results).map((group) => (
    group.items.length > 1
      ? formatRosterGroupLine(group, lang)
      : { ...formatResultLine(group.items[0], lang), item: group.items[0] }
  ));

  formatted.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aSupport = isSupportClass(a.item.snapClassName) ? 1 : 0;
    const bSupport = isSupportClass(b.item.snapClassName) ? 1 : 0;
    if (aSupport !== bSupport) return aSupport - bSupport;
    return 0;
  });

  return formatted.map((f) => f.line);
}
