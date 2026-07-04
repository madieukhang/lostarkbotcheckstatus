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
import { rosterUrl } from '../../utils/rosterLink.js';

const FIELD_VALUE_LIMIT = 1024;

function lcKey(value) {
  return String(value || '').trim().toLowerCase();
}

function classNameFromRecord(record) {
  if (!record) return '';
  if (record.className) return record.className;
  if (record.classId) return getClassName(record.classId);
  return '';
}

function parsePositiveNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Build a single numbered alt line. Class icon + ilvl + CP are
 * appended when a stat record is available; the bare `[name](link)`
 * survives when no record is supplied (legacy entries / approval-DM
 * preview surfaces that don't have a snapshot map).
 */
export function formatAltLine(name, index, record) {
  const className = classNameFromRecord(record);
  const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';
  const statParts = [];
  const itemLevel = parsePositiveNumber(record?.itemLevel);
  if (itemLevel > 0) statParts.push(`\`${itemLevel.toFixed(2)}\``);
  if (record?.combatScore && record.combatScore !== '?') statParts.push(`CP \`${record.combatScore}\``);
  const statSuffix = statParts.length > 0 ? ` · ${statParts.join(' · ')}` : '';
  return `**${index + 1}.** ${classPrefix}[${name}](${rosterUrl(name)})${statSuffix}`;
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
 * @param {string} options.primaryName - Entry's own name (filtered out).
 * @param {Map<string, object>} [options.statMap] - Lowercase-name → snapshot record.
 * @param {string|null} [options.emptySentinel] - Field value when no alts.
 * @param {string} [options.label='🧬 Tracked alts'] - Field-name prefix. Lets
 *   the enrich broadcast reuse this renderer as a "🆕 New alts" field while
 *   every other surface keeps the tracked-alts wording.
 * @returns {{name: string, value: string, inline: boolean} | null}
 */
export function renderTrackedAltsField({
  names,
  primaryName,
  statMap = new Map(),
  emptySentinel = null,
  label = '🧬 Tracked alts',
} = {}) {
  const all = Array.isArray(names) ? names : [];
  const primaryKey = lcKey(primaryName);
  const others = all
    .map((n) => String(n || '').trim())
    .filter((n) => n && lcKey(n) !== primaryKey);

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
  for (const name of others) {
    const line = formatAltLine(name, lines.length, statMap.get(lcKey(name)));
    const hiddenAfterThis = others.length - lines.length - 1;
    const overflowLine = hiddenAfterThis > 0 ? `\n*... and ${hiddenAfterThis} more*` : '';
    const candidate = [...lines, line].join('\n') + overflowLine;
    if (candidate.length > FIELD_VALUE_LIMIT && lines.length > 0) break;
    lines.push(line);
  }

  const hiddenCount = others.length - lines.length;
  const extra = hiddenCount > 0 ? `\n*... and ${hiddenCount} more*` : '';
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
    map.set(lcKey(record.name), record);
  }
  return map;
}
