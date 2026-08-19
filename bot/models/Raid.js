/**
 * Allowed raid labels for /la-list add.
 */
export const RAIDS = [
  'Act4 Nor',
  'Act4 Hard',
  'Kazeros Nor',
  'Kazeros Hard',
  'Mordum Hard',
  'Secra Nor',
  'Secra Hard',
  'Secra NM',
  // Horizon ships with three level tiers (Lv1/Lv2/Lv3) instead of
  // Nor/Hard/NM difficulties · mirrors the RaidManage catalog's
  // Horizon Level 1/2/3. Newest content, so it sorts last like in-game.
  'Horizon Lv1',
  'Horizon Lv2',
  'Horizon Lv3',
];

/**
 * Build Discord string option choices from the raid list.
 * @returns {Array<{name: string, value: string}>}
 */
export function getRaidChoices() {
  return RAIDS.map((raid) => ({ name: raid, value: raid }));
}

/**
 * Build Discord autocomplete choices for /la-list add's raid option.
 * Watchlist entries may keep the caller's free-form label while every list
 * still receives the canonical raid suggestions.
 *
 * @param {string} focusedValue
 * @param {{allowCustom?: boolean}} [options]
 * @returns {Array<{name: string, value: string}>}
 */
export function getRaidAutocompleteChoices(focusedValue = '', { allowCustom = false } = {}) {
  const input = String(focusedValue ?? '').trim();
  const needle = input.toLocaleLowerCase();
  const matchingRaids = RAIDS.filter((raid) => raid.toLocaleLowerCase().includes(needle));
  const hasCanonicalMatch = RAIDS.some((raid) => raid.toLocaleLowerCase() === needle);
  const choices = [];

  if (allowCustom && input && !hasCanonicalMatch) {
    choices.push({
      name: `Custom · ${input}`.slice(0, 100),
      value: input,
    });
  }

  for (const raid of matchingRaids) {
    if (choices.length >= 25) break;
    choices.push({ name: raid, value: raid });
  }

  return choices;
}

/**
 * Normalize a raid submitted through an autocomplete string option.
 * Canonical raids are matched case-insensitively and stored with their
 * standard spelling. Only callers that explicitly opt in may retain a
 * custom label.
 *
 * @param {string} value
 * @param {{allowCustom?: boolean}} [options]
 * @returns {string|null} Empty string when omitted, null when unsupported.
 */
export function resolveRaidLabel(value = '', { allowCustom = false } = {}) {
  const input = String(value ?? '').trim();
  if (!input) return '';

  const canonical = RAIDS.find((raid) => raid.toLocaleLowerCase() === input.toLocaleLowerCase());
  if (canonical) return canonical;

  return allowCustom ? input : null;
}

/**
 * Apply /la-list add's list-specific rule: custom raid labels belong only to
 * watchlist entries.
 *
 * @param {'black'|'white'|'watch'} type
 * @param {string} value
 * @returns {string|null}
 */
export function resolveListAddRaidLabel(type, value = '') {
  return resolveRaidLabel(value, { allowCustom: type === 'watch' });
}
