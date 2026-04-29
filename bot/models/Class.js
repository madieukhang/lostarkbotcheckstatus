/**
 * Mapping of lostark.bible internal class IDs to display names.
 * Update this file when new classes are added to the game.
 */
export const CLASS_NAMES = {
  // Warriors
  berserker:          'Berserker',
  berserker_female:   'Slayer',
  dragon_knight:      'Guardian Knight',
  warlord:            'Gunlancer',
  holyknight:         'Paladin',
  holyknight_female:  'Valkyrie',
  destroyer:          'Destroyer',

  // Martial Artists
  battle_master:      'Wardancer',
  infighter:          'Scrapper',
  soulmaster:         'Soulfist',
  force_master:       'Soulfist',
  lance_master:       'Glaivier',
  infighter_male:     'Breaker',
  battle_master_male:  'Striker',

  // Gunners
  devil_hunter:       'Deadeye',
  devil_hunter_female:'Gunslinger',
  blaster:            'Artillerist',
  hawkeye:            'Sharpshooter',
  hawk_eye:           'Sharpshooter',
  scouter:            'Machinist',

  // Mages
  bard:               'Bard',
  arcana:             'Arcanist',
  summoner:           'Summoner',
  elemental_master:   'Sorceress',

  // Assassins
  blade:              'Deathblade',
  demonic:            'Shadow Hunter',
  reaper:             'Reaper',
  soul_eater:         'Souleater',

  // Specialists
  yinyangshi:         'Artist',
  weather_artist:     'Aeromancer',
  alchemist:          'Wildsoul',
};

/**
 * Resolve a lostark.bible class ID to a human-readable display name.
 * Falls back to a title-cased version of the ID if not found.
 * @param {string} clsId
 * @returns {string}
 */
export function getClassName(clsId) {
  if (!clsId) return '';
  return CLASS_NAMES[clsId] ?? clsId.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeClassSearch(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Resolve either an internal class ID or display name to the internal ID used
 * by lostark.bible search results.
 * @param {string} value
 * @returns {string|null}
 */
export function resolveClassId(value) {
  const needle = normalizeClassSearch(value);
  if (!needle) return null;

  for (const [id, name] of Object.entries(CLASS_NAMES)) {
    if (normalizeClassSearch(id) === needle || normalizeClassSearch(name) === needle) {
      return id;
    }
  }

  return value;
}

/**
 * Build autocomplete choices for Discord's 25-result cap without losing
 * classes beyond the first 25 static choices.
 * @param {string} focusedValue
 * @returns {Array<{name: string, value: string}>}
 */
export function getClassAutocompleteChoices(focusedValue = '') {
  const needle = normalizeClassSearch(focusedValue);
  const seenNames = new Set();
  const choices = [];

  for (const [id, name] of Object.entries(CLASS_NAMES)) {
    if (seenNames.has(name)) continue;
    seenNames.add(name);

    if (
      needle &&
      !normalizeClassSearch(name).includes(needle) &&
      !normalizeClassSearch(id).includes(needle)
    ) {
      continue;
    }

    choices.push({ name, value: id });
  }

  return choices.slice(0, 25);
}
