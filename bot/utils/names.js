function normalizeNameGlyphs(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/(\p{L})\s*\u00A8/gu, '$1\u0308')
    // Lost Ark lobby font can make Gemini split "ü" into "iù".
    .replace(/i(?:\u00F9|u\u0300)/g, '\u00FC')
    .replace(/(?:\u00EC|i\u0300)u/g, '\u00FC')
    .replace(/I(?:\u00D9|U\u0300)/g, '\u00DC')
    .replace(/(?:\u00CC|I\u0300)U/g, '\u00DC')
    .replace(/(\p{L})\s+([\u0300-\u036f])/gu, '$1$2')
    // Lost Ark character names are single tokens. OCR sometimes inserts
    // spaces before repeated tail letters, e.g. "Gunlancer rrrrr".
    .replace(/\s+/g, '')
    // Keep this scoped to the observed full-name stem so legitimate
    // Vietnamese grave-accent names keep their "ù".
    .replace(/b\u00E1nhcanhc(?:\u00F9|u\u0300)a/giu, 'b\u00E1nhcanhc\u00FCa')
    .replace(/b\u00E1nhcanh(?:\u00F9|u\u0300)a/giu, 'b\u00E1nhcanhc\u00FCa')
    .trim()
    .normalize('NFC');
}

const CHARACTER_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N}]{1,19}$/u;

/**
 * Stable identity key for character-name maps, sets, and caches.
 *
 * Keep display normalization in `normalizeCharacterName`; identity lookups only
 * need whitespace removal, canonical Unicode composition, and case folding.
 * Centralizing that smaller contract prevents each roster/list surface from
 * inventing a subtly different key (especially for decomposed diacritics).
 */
export function normalizeNameKey(value) {
  return String(value || '').trim().normalize('NFC').toLowerCase();
}

/**
 * Clean and deduplicate a batch of character names without changing its order.
 * The first spelling is retained for display, while NFC/case-equivalent values
 * share one identity. This is the common boundary for OCR, text, and DB batches.
 */
export function normalizeNameList(values = []) {
  const input = Array.isArray(values) ? values : [values];
  const names = new Map();
  for (const raw of input) {
    if (typeof raw === 'string') rememberNormalizedName(names, raw);
  }
  return [...names.values()];
}

/**
 * Collect a canonical name once while preserving its first display spelling.
 * @param {Map<string, string>} namesByKey Destination index.
 * @param {unknown} rawName Name to trim, NFC-normalize, and index.
 * @returns {void}
 */
export function rememberNormalizedName(namesByKey, rawName) {
  const name = String(rawName || '').trim().normalize('NFC');
  const key = normalizeNameKey(name);
  if (key && !namesByKey.has(key)) namesByKey.set(key, name);
}

/** Build a canonical-name index for snapshots or other name-bearing records. */
export function buildNameKeyMap(values = [], getName = (value) => value?.name) {
  const map = new Map();
  for (const value of values || []) {
    const key = normalizeNameKey(getName(value));
    if (key) map.set(key, value);
  }
  return map;
}

export function isValidCharacterName(value) {
  return CHARACTER_NAME_RE.test(String(value || '').normalize('NFC'));
}

export function normalizeCharacterName(raw) {
  const value = normalizeNameGlyphs(raw);
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

export function normalizeRosterNames(primaryName, rosterNames = []) {
  const out = [];
  const seen = new Set();
  for (const raw of [primaryName, ...rosterNames]) {
    const clean = normalizeCharacterName(raw);
    if (!clean) continue;
    const key = normalizeNameKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out.length > 0 ? out : [primaryName];
}

export function getInteractionDisplayName(interaction) {
  const member = interaction.member;
  if (member && typeof member === 'object') {
    if ('displayName' in member && typeof member.displayName === 'string' && member.displayName.trim()) {
      return member.displayName.trim();
    }
    if ('nick' in member && typeof member.nick === 'string' && member.nick.trim()) {
      return member.nick.trim();
    }
  }

  return interaction.user.globalName?.trim() || interaction.user.username;
}

export function getAddedByDisplay(entry) {
  return entry?.addedByDisplayName?.trim() || entry?.addedByName?.trim() || '';
}

/**
 * Parse the comma-separated `additional_names` option of /la-list edit.
 *
 * Splits on `,`, trims and title-cases each piece (via
 * normalizeCharacterName), drops empties and within-input duplicates,
 * then partitions the remainder against the entry's existing roster:
 *   - `added`      : names that are genuinely new to the entry.
 *   - `duplicates` : names already on the entry (primary or alt). The
 *                    success message surfaces these so the officer
 *                    knows which ones were no-ops.
 *
 * Comparison is case-insensitive (lowercase keys); the persisted form
 * uses the title-cased version returned by normalizeCharacterName.
 *
 * @param {string} raw
 * @param {string[]} [existing] - allCharacters already on the entry.
 * @param {string} [primaryName] - The entry's primary name field.
 * @returns {{ added: string[], duplicates: string[] }}
 */
export function parseAdditionalNames(raw, existing = [], primaryName = '') {
  if (!raw || typeof raw !== 'string') return { added: [], duplicates: [] };
  const existingSet = new Set(
    [...existing, primaryName]
      .map(normalizeNameKey)
      .filter(Boolean)
  );
  const seen = new Set();
  const added = [];
  const duplicates = [];
  for (const part of raw.split(',')) {
    const normalized = normalizeCharacterName(part);
    if (!normalized) continue;
    const lower = normalizeNameKey(normalized);
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (existingSet.has(lower)) {
      duplicates.push(normalized);
    } else {
      added.push(normalized);
    }
  }
  return { added, duplicates };
}
