/**
 * trackedAltsRender.js
 *
 * Single source of truth for the "🧬 Tracked alts" field rendered on
 * /la-list view evidence detail, /la-list add success, /la-list add
 * approval DMs, and cross-server broadcast cards.
 *
 * Before this module each call site grew its own copy of the same
 * numbered-list-with-overflow logic, drifting on cap behaviour
 * (hard-coded 12 vs dynamic field-size fitting), per-row enrichment
 * (links only vs class icon + ilvl + CP), and empty-state handling
 * (sentinel field vs skipped field vs returned null). Centralising
 * the renderer here keeps all four surfaces visually identical and
 * makes future tweaks (cap, overflow wording, link host) a one-file
 * change.
 *
 * The module sits at the `handlers/list/` layer, not `helpers.js`,
 * because it must be importable by services/broadcasts.js without a
 * circular dependency (broadcasts.js already imports helpers.js for
 * getListContext).
 */

import { getClassEmoji, getClassName } from '../../models/Class.js';
import { normalizeNameKey } from '../../utils/names.js';
import { rosterUrl } from '../../utils/rosterLink.js';

const FIELD_VALUE_LIMIT = 1024;

function classNameFromRecord(record) {
  return record?.className || (record?.classId ? getClassName(record.classId) : '');
}

function parsePositiveNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Format the two numeric roster values once so standalone metadata fields and
 * tracked-roster rows cannot drift on precision, code badges, or the CP unit.
 */
export function formatRosterStatBadges(record) {
  const itemLevel = parsePositiveNumber(record?.itemLevel);
  const combatScore = String(record?.combatScore ?? '').trim();
  const combatPower = combatScore && combatScore !== '?'
    ? (/\sCP$/iu.test(combatScore) ? combatScore : `${combatScore} CP`)
    : '';

  return {
    itemLevel: itemLevel > 0 ? `\`${itemLevel.toFixed(2)}\`` : '',
    combatPower: combatPower ? `\`${combatPower}\`` : '',
  };
}

/**
 * Render one character with the same class-icon + roster-link vocabulary used
 * across list cards. The class name remains a readable fallback while custom
 * application emoji are still bootstrapping.
 */
export function formatLinkedCharacter(name, record, { bold = true } = {}) {
  const className = classNameFromRecord(record);
  const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';
  const linkedName = `[${name}](${rosterUrl(name)})`;
  return `${classPrefix}${bold ? `**${linkedName}**` : linkedName}`;
}

/**
 * Build a single numbered alt line. Class icon + ilvl + CP are
 * appended when a stat record is available; the bare `[name](link)`
 * survives when no record is supplied (legacy entries / approval-DM
 * preview surfaces that don't have a snapshot map).
 */
export function formatAltLine(name, index, record) {
  const { itemLevel, combatPower } = formatRosterStatBadges(record);
  const statParts = [itemLevel, combatPower].filter(Boolean);
  const statSuffix = statParts.length > 0 ? ` · ${statParts.join(' · ')}` : '';
  return `**${index + 1}.** ${formatLinkedCharacter(name, record, { bold: false })}${statSuffix}`;
}

/**
 * Build the "🧬 Tracked alts" embed field for an entry.
 *
 * Fits as many alt rows as the 1024-char field-value budget allows,
 * then appends an `*... and N more*` overflow tail. Lines are
 * rendered through `formatAltLine` so class icon + ilvl + CP appear
 * when a stat record is provided for that name.
 *
 * Empty-result behaviour is callsite-configurable:
 *   - `emptySentinel: '...'` returns the field with the sentinel as
 *     its value (used by /la-list view evidence detail and /la-list
 *     add success, where the field is part of the layout grammar and
 *     should always render).
 *   - `emptySentinel: null` (default) returns `null` so the caller
 *     can skip pushing the field entirely (used by approval DMs and
 *     broadcast cards where an alt-less row reads as no extra info).
 *
 * @param {Object} options
 * @param {string[]} options.names - allCharacters / discovered alts.
 * @param {string} options.primaryName - Entry's own name. Filtered out unless
 *   `includePrimary` is enabled.
 * @param {Map<string, object>} [options.statMap] - Lowercase-name → snapshot record.
 * @param {boolean} [options.includePrimary=false] - Prepend and retain the entry's
 *   own character so roster-oriented fields include the complete tracked roster.
 * @param {string|null} [options.emptySentinel] - Field value when no alts.
 * @param {string} [options.label='🧬 Tracked alts'] - Field-name prefix. Lets
 *   the enrich broadcast reuse this renderer as a "🆕 New alts" field while
 *   every other surface keeps the tracked-alts wording.
 * @param {string} [options.overflowTemplate='... and {count} more'] - Localized
 *   overflow copy. `{count}` is replaced after the renderer knows the fit.
 * @returns {{name: string, value: string, inline: boolean} | null}
 */
export function renderTrackedAltsField({
  names,
  primaryName,
  statMap = new Map(),
  includePrimary = false,
  emptySentinel = null,
  label = '🧬 Tracked alts',
  overflowTemplate = '... and {count} more',
} = {}) {
  const all = Array.isArray(names) ? names : [];
  const primaryKey = normalizeNameKey(primaryName);
  const candidates = includePrimary ? [primaryName, ...all] : all;
  const seen = new Set();
  const others = candidates
    .map((n) => String(n || '').trim())
    .filter((n) => {
      const key = normalizeNameKey(n);
      if (!n || (!includePrimary && key === primaryKey) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (others.length === 0) {
    if (emptySentinel == null) return null;
    return {
      name: label,
      value: emptySentinel,
      inline: false,
    };
  }

  // Dynamic fit: stop as soon as adding the next line plus the
  // overflow tail would blow the 1024-char field budget. Lifted from
  // services/broadcasts.js's buildTrackedAltsField so deep rosters
  // with rich stat rows still render gracefully.
  const lines = [];
  const overflowText = (count) => String(overflowTemplate).replace('{count}', String(count));
  for (const name of others) {
    const line = formatAltLine(name, lines.length, statMap.get(normalizeNameKey(name)));
    const hiddenAfterThis = others.length - lines.length - 1;
    const overflowLine = hiddenAfterThis > 0 ? `\n*${overflowText(hiddenAfterThis)}*` : '';
    const candidate = [...lines, line].join('\n') + overflowLine;
    if (candidate.length > FIELD_VALUE_LIMIT && lines.length > 0) break;
    lines.push(line);
  }

  const hiddenCount = others.length - lines.length;
  const extra = hiddenCount > 0 ? `\n*${overflowText(hiddenCount)}*` : '';
  return {
    name: `${label} (${others.length})`,
    value: (lines.join('\n') + extra).slice(0, FIELD_VALUE_LIMIT),
    inline: false,
  };
}

/**
 * Build a `Map<lowercaseName, statRecord>` from an array of
 * per-character records (the shape `buildRosterCharacters.rosterCharacters`
 * returns: `{ name, classId, className, itemLevel, combatScore }`).
 * Used by /la-list add success to pass class icon + ilvl into the
 * shared renderer without callsite churn.
 */
export function statMapFromRosterCharacters(rosterCharacters = []) {
  const map = new Map();
  for (const record of rosterCharacters || []) {
    if (!record?.name) continue;
    map.set(normalizeNameKey(record.name), record);
  }
  return map;
}

/**
 * Resolve the in-game server for an entry, reading across its roster.
 *
 * The server belongs to the roster, not to one character, so any sibling
 * that has been scraped answers for all of them. This matters because a
 * character's own snapshot often has none: rows written before the field
 * existed carry nothing, and the name-search route that /la-check falls
 * back to cannot report a server at all. The cards already hold every
 * sibling's snapshot to print class + ilvl, so reading the server out of
 * them costs no extra request.
 *
 * Display-time only · a value inferred this way is deliberately not
 * written back, so a wrong guess costs one render rather than a stored
 * row that outlives it.
 *
 * @param {{name?: string, allCharacters?: string[]}} entry - list entry
 * @param {Map<string, {world?: string}>} [statMap] - snapshots keyed by
 *   lowercased character name
 * @returns {string} the server name, or '' when no sibling knows one
 */
export function resolveRosterWorld(entry, statMap = new Map()) {
  const readWorld = (name) => String(statMap.get(normalizeNameKey(name))?.world || '').trim();

  // The entry's own snapshot wins · only fall back to siblings when it
  // has nothing to say.
  const own = readWorld(entry?.name);
  if (own) return own;

  for (const sibling of entry?.allCharacters || []) {
    const world = readWorld(sibling);
    if (world) return world;
  }
  return '';
}
