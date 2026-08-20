/**
 * Raid catalog separates the durable stored value from its temporary choice
 * label/availability. Historical values stay here forever so entries created
 * while a raid was selectable continue to render and normalize correctly.
 */
const RAID_CATALOG = [
  // Normal raids are retired from new selections now that their solo modes
  // cover the common use case. Keep the values for existing entries and old
  // multiadd workbooks, just like other archived choices below.
  { value: 'Act4 Nor', selectable: false },
  { value: 'Act4 Hard' },
  { value: 'Kazeros Nor', selectable: false },
  { value: 'Kazeros Hard' },
  // Mordum is retired from new selections but remains a recognized stored
  // value for existing entries and older multiadd workbooks.
  { value: 'Mordum Hard', selectable: false },
  { value: 'Secra Nor', selectable: false },
  { value: 'Secra Hard' },
  { value: 'Secra NM' },
  // Horizon ships with three level tiers (Lv1/Lv2/Lv3) instead of
  // Nor/Hard/NM difficulties · mirrors the RaidManage catalog's
  // Horizon Level 1/2/3. Newest permanent content sorts last like in-game.
  { value: 'Horizon Lv1' },
  { value: 'Horizon Lv2' },
  { value: 'Horizon Lv3' },
  {
    value: 'Brel Extreme (Limited)',
    choiceName: 'Brel Extreme (Limited Time) Choose',
    // Hide at 00:00 on 2 September 2026 in Vietnam (UTC+7).
    selectableUntil: '2026-09-01T17:00:00.000Z',
  },
];

/**
 * Every canonical value that may already exist in storage. This intentionally
 * includes retired/expired raids; use getRaidChoices() for new selections.
 */
export const RAIDS = RAID_CATALOG.map(({ value }) => value);

function isRaidSelectable(raid, now) {
  if (raid.selectable === false) return false;
  if (!raid.selectableUntil) return true;
  return new Date(now).getTime() < Date.parse(raid.selectableUntil);
}

function getSelectableRaids({ now = new Date() } = {}) {
  return RAID_CATALOG.filter((raid) => isRaidSelectable(raid, now));
}

/**
 * Build Discord string option choices from the raid list.
 * @param {{now?: Date|string|number}} [options]
 * @returns {Array<{name: string, value: string}>}
 */
export function getRaidChoices(options = {}) {
  return getSelectableRaids(options).map((raid) => ({
    name: raid.choiceName || raid.value,
    value: raid.value,
  }));
}

/**
 * Values suitable for selectors that cannot separate option name from value
 * (for example Excel data validation dropdowns).
 * @param {{now?: Date|string|number}} [options]
 * @returns {string[]}
 */
export function getSelectableRaidValues(options = {}) {
  return getSelectableRaids(options).map(({ value }) => value);
}

/**
 * Build Discord autocomplete choices for /la-list add's raid option.
 * Watchlist entries may keep the caller's free-form label while every list
 * still receives the canonical raid suggestions.
 *
 * @param {string} focusedValue
 * @param {{allowCustom?: boolean, now?: Date|string|number}} [options]
 * @returns {Array<{name: string, value: string}>}
 */
export function getRaidAutocompleteChoices(
  focusedValue = '',
  { allowCustom = false, now = new Date() } = {},
) {
  const input = String(focusedValue ?? '').trim();
  const needle = input.toLocaleLowerCase();
  const matchingRaids = getSelectableRaids({ now }).filter((raid) => (
    raid.value.toLocaleLowerCase().includes(needle)
    || raid.choiceName?.toLocaleLowerCase().includes(needle)
  ));
  const hasCanonicalMatch = RAID_CATALOG.some((raid) => (
    raid.value.toLocaleLowerCase() === needle
    || raid.choiceName?.toLocaleLowerCase() === needle
  ));
  const choices = [];

  if (allowCustom && input && !hasCanonicalMatch) {
    choices.push({
      name: `Custom · ${input}`.slice(0, 100),
      value: input,
    });
  }

  for (const raid of matchingRaids) {
    if (choices.length >= 25) break;
    choices.push({ name: raid.choiceName || raid.value, value: raid.value });
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

  const canonical = RAID_CATALOG.find((raid) => (
    raid.value.toLocaleLowerCase() === input.toLocaleLowerCase()
    || raid.choiceName?.toLocaleLowerCase() === input.toLocaleLowerCase()
  ));
  if (canonical) return canonical.value;

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
