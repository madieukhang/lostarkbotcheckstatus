import { getClassEmoji, isSupportClass } from '../../models/Class.js';
import { normalizeNameKey } from '../../utils/names.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { t } from '../i18n/index.js';
import { groupListCheckResults } from './displayGroups.js';
import { didListCheckNameChange } from './matchResolution.js';

export const LIST_CHECK_ALT_PREVIEW_LIMIT = 3;

// The names in these branches are characters in their own right, so they
// link out to their roster page like every other name on the card. Their
// class metadata comes from the related-name snapshot/search pass in service.
function linkName(name, item) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return trimmed;
  // Class comes from the related-name snapshots the check service loads
  // for the entry and its alts · the searched name has its own
  // snapClassName, and everyone else was previously rendered bare.
  const className = item?.relatedClasses?.[normalizeNameKey(trimmed)] || '';
  const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';
  return `${classPrefix}[${trimmed}](${rosterUrl(trimmed)})`;
}

const LIST_ENTRY_BRANCHES = [
  ['black', 'blackEntry'],
  ['white', 'whiteEntry'],
  ['watch', 'watchEntry'],
];

const RESULT_STATES = [
  { entryKey: 'blackEntry', icon: '⛔', priority: 0 },
  { entryKey: 'watchEntry', icon: '⚠️', priority: 1 },
  { entryKey: 'whiteEntry', icon: '✅', priority: 2 },
  { entryKey: 'trustedEntry', icon: '🛡️', priority: 2, trustedOnly: true },
];

const NOT_LISTED_STATE = { icon: '❓', priority: 3 };

function collectAltExcludedNames(item) {
  return [
    item.name,
    ...RESULT_STATES.map(({ entryKey }) => item[entryKey]?.name),
    ...Object.values(item.matchDetails || {}).map((detail) => detail?.matchedName),
  ];
}

function formatMatchContext(item, entry, listType, lang) {
  const detail = item.matchDetails?.[listType];
  if (detail?.kind === 'roster') {
    const matchedName = String(detail.matchedName || entry.name || '').trim();
    if (normalizeNameKey(matchedName) === normalizeNameKey(entry.name)) {
      return t('dialogue.check.format.rosterVia', lang, { name: linkName(matchedName, item) });
    }
    return t('dialogue.check.format.rosterEntry', lang, {
      name: linkName(matchedName, item),
      entry: linkName(entry.name, item),
    });
  }
  if (normalizeNameKey(entry.name) !== normalizeNameKey(item.name)) {
    return t('dialogue.check.format.via', lang, { name: linkName(entry.name, item) });
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
 * Filters out the item's own name plus names already rendered by a `via`
 * branch, then dedupes case-insensitively.
 */
export function pickAltsForDisplay(item, excludedNames = collectAltExcludedNames(item)) {
  const sourceEntry = item.blackEntry || item.whiteEntry || item.watchEntry || item.trustedEntry;
  const raw = (sourceEntry?.allCharacters && sourceEntry.allCharacters.length > 0)
    ? sourceEntry.allCharacters
    : (Array.isArray(item.discoveredAlts) ? item.discoveredAlts : []);
  if (raw.length === 0) return [];
  const seen = new Set(excludedNames.map(normalizeNameKey).filter(Boolean));
  const out = [];
  for (const n of raw) {
    const trimmed = String(n || '').trim();
    if (!trimmed) continue;
    const key = normalizeNameKey(trimmed);
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
  // CP carries its unit inside the badge, as every other character row
  // in the bot does · one badge, one labelled value.
  return item.snapItemLevel > 0
    ? ` · \`${item.snapItemLevel.toFixed(2)}\`${item.snapCombatScore ? ` · \`${item.snapCombatScore} CP\`` : ''}`
    : '';
}

function formatBranch(parts) {
  const content = parts.filter(Boolean).join(' · ');
  return content ? `   ↳ ${content}` : '';
}

function formatBranchBlock(branches) {
  return branches.length > 0 ? `\n${branches.join('\n')}` : '';
}

function wrapTrimmed(value, wrap) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? wrap(trimmed) : '';
}

function formatCorrectionBranch(item, lang) {
  if (!didListCheckNameChange(item)) return '';
  const correctionKey = item.inputSource === 'ocr' ? 'correctedOcr' : 'correctedText';
  return formatBranch([t(`dialogue.check.format.${correctionKey}`, lang, {
    input: item.inputName,
    name: item.name,
  })]);
}

function formatListEntryBranches(item, entry, listType, lang) {
  if (!entry) return [];
  return [
    // Keep the report itself compact: reason and raid describe the same entry.
    // An indirect match is navigation context, so it gets a separate line.
    formatBranch([
      wrapTrimmed(entry.reason, (reason) => `*${reason}*`),
      wrapTrimmed(entry.raid, (raid) => `\`${raid}\``),
    ]),
    formatBranch([formatMatchContext(item, entry, listType, lang)]),
  ].filter(Boolean);
}

function formatAltsBranch(item, lang) {
  const alts = pickAltsForDisplay(item);
  if (alts.length === 0) return '';

  const visible = alts.slice(0, LIST_CHECK_ALT_PREVIEW_LIMIT);
  const remainingCount = alts.length - visible.length;
  const tail = remainingCount > 0
    ? ` *${t('dialogue.check.format.more', lang, { count: remainingCount })}*`
    : '';
  const linked = visible.map((altName) => linkName(altName, item));
  return formatBranch([
    `${t('dialogue.check.format.alts', lang)}: ${linked.join(', ')}${tail}`,
  ]);
}

function collectResultBranches(item, lang) {
  return [
    formatCorrectionBranch(item, lang),
    ...LIST_ENTRY_BRANCHES.flatMap(([listType, entryKey]) => (
      formatListEntryBranches(item, item[entryKey], listType, lang)
    )),
    formatAltsBranch(item, lang),
  ].filter(Boolean);
}

function resolveResultState(item) {
  return RESULT_STATES.find(({ entryKey }) => item[entryKey]) || NOT_LISTED_STATE;
}

function formatResultName(item, emphasizeName) {
  if (!emphasizeName) return item.name;
  return `**${linkName(item.name) || item.name}**`;
}

function formatStandardResult(item, state, classPrefix, statSuffix, branches, lang, linkUnlisted) {
  const isListHit = Boolean(state.entryKey);
  const scopeTag = state.entryKey === 'blackEntry' && item.blackEntry?.scope === 'server'
    ? ` (${t('dialogue.check.format.local', lang)})`
    : '';
  const trustedTag = isListHit && item.trustedEntry ? ' 🛡️' : '';
  return {
    line: `${state.icon} ${classPrefix}${formatResultName(item, isListHit || linkUnlisted)}${scopeTag}${trustedTag}${statSuffix}${formatBranchBlock(branches)}`,
    priority: state.priority,
  };
}

function formatTrustedResult(item, state, classPrefix, statSuffix, branches, lang) {
  const trustedContext = formatMatchContext(item, item.trustedEntry, 'trusted', lang);
  const trustedLabel = t('dialogue.check.format.trusted', lang);
  const directTag = trustedContext ? '' : ` · ${trustedLabel}`;
  const trustedBranches = [
    trustedContext ? formatBranch([trustedContext, trustedLabel]) : '',
    ...branches,
  ].filter(Boolean);

  return {
    line: `${state.icon} ${classPrefix}${formatResultName(item, true)}${statSuffix}${directTag}${formatBranchBlock(trustedBranches)}`,
    priority: state.priority,
  };
}

/**
 * Build one character row without grouping or changing the caller's order.
 *
 * Layout:
 *   [status-icon] [class-icon] **Name** · `ilvl` · `nnn CP`
 *      ↳ reason · [raid]                        (when reported)
 *      ↳ via Other                             (for an indirect match)
 *      ↳ via Other · trusted                    (only when trusted via roster)
 *      ↳ alts: A, B, C +N more                  (when alts are known)
 *
 * @param {object} item - List-check-shaped character and matched entries.
 * @param {string} [lang='en']
 * @param {{linkUnlisted?: boolean}} [options] - Search links every returned character.
 * @returns {{ line: string, priority: number }}
 */
export function formatResultLine(item, lang = 'en', { linkUnlisted = false } = {}) {
  const state = resolveResultState(item);
  const classPrefix = getClassPrefix(item);
  const statSuffix = getStatSuffix(item);
  const branches = collectResultBranches(item, lang);

  return state.trustedOnly
    ? formatTrustedResult(item, state, classPrefix, statSuffix, branches, lang)
    : formatStandardResult(item, state, classPrefix, statSuffix, branches, lang, linkUnlisted);
}

/**
 * Format check results into Discord-ready text lines.
 * Multiple photographed characters backed by the same list entry collapse to
 * one representative row. That row deliberately keeps the original compact
 * name → via/reason → alts layout instead of expanding every roster member.
 * Rows are sorted by priority: blacklist, watchlist, whitelist/trusted, not listed.
 *
 * @param {Array<object>} results - Output from checkNamesAgainstLists
 * @returns {string[]} Formatted lines sorted by display priority
 */
export function formatCheckResults(results, lang = 'en') {
  const formatted = groupListCheckResults(results).map((group) => {
    const item = group.items[0];
    return { ...formatResultLine(item, lang), item };
  });

  formatted.sort((a, b) => (
    a.priority - b.priority
    || Number(isSupportClass(a.item.snapClassName)) - Number(isSupportClass(b.item.snapClassName))
  ));

  return formatted.map((f) => f.line);
}
