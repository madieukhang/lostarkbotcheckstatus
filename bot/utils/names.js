export function normalizeCharacterName(raw) {
  const value = raw.trim();
  if (!value) return '';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
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
      .map((n) => (n || '').toLowerCase())
      .filter(Boolean)
  );
  const seen = new Set();
  const added = [];
  const duplicates = [];
  for (const part of raw.split(',')) {
    const normalized = normalizeCharacterName(part);
    if (!normalized) continue;
    const lower = normalized.toLowerCase();
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
