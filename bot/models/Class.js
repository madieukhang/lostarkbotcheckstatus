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
 * Hard-support classes in current Lost Ark meta. Everyone else is DPS.
 * Stored as display names (not bible class IDs) because consuming code
 * reads `className` which is already the resolved display form.
 * Matches sister bot RaidManage's SUPPORT_CLASS_NAMES so the two bots
 * agree on role classification.
 */
export const SUPPORT_CLASS_NAMES = new Set([
  'Bard',
  'Paladin',
  'Artist',
  'Valkyrie',
]);

/**
 * @param {string} className - Display name (e.g., "Bard", "Berserker").
 * @returns {boolean} True when the class is a hard-support.
 */
export function isSupportClass(className) {
  return SUPPORT_CLASS_NAMES.has(String(className || '').trim());
}

/**
 * Map of class display name -> Discord application emoji string.
 *
 * Seeded empty here. The bot's startup bootstrap
 * (`bot/services/emojiBootstrap.js`) populates entries at runtime by
 * uploading PNGs from `assets/class-icons/` as application emoji
 * (content-addressed naming: `{bibleId}_{md5short}`) and mutating
 * this map with the resulting `<:name:id>` strings keyed by display
 * name. Bootstrap is ported from sister bot RaidManage to keep the
 * two visually consistent when raid + list cards reference classes.
 *
 * Any class missing from the map (bootstrap hasn't run yet, or upload
 * failed) renders without an icon prefix · safe no-op fallback so the
 * bot keeps working with degraded UX rather than crashing.
 *
 * Format: `<:emoji_name:emoji_id>` (no spaces, no leading backslash).
 */
export const CLASS_EMOJI_MAP = {
  // Warriors
  Berserker: '',
  Slayer: '',
  Gunlancer: '',
  Paladin: '',
  Valkyrie: '',
  Destroyer: '',
  'Guardian Knight': '',
  // Martial Artists
  Wardancer: '',
  Scrapper: '',
  Soulfist: '',
  Glaivier: '',
  Striker: '',
  Breaker: '',
  // Gunners
  Deadeye: '',
  Gunslinger: '',
  Artillerist: '',
  Sharpshooter: '',
  Machinist: '',
  // Mages
  Bard: '',
  Arcanist: '',
  Summoner: '',
  Sorceress: '',
  // Assassins
  Deathblade: '',
  'Shadow Hunter': '',
  Reaper: '',
  Souleater: '',
  // Specialists
  Artist: '',
  Aeromancer: '',
  Wildsoul: '',
};

/**
 * @param {string} className - Display name (e.g., "Bard", "Berserker").
 * @returns {string} Discord custom emoji string `<:name:id>` for the class,
 *   or empty string when the class isn't mapped (yet) · empty string is
 *   a safe no-op when prepended to a char name template literal.
 */
export function getClassEmoji(className) {
  return CLASS_EMOJI_MAP[String(className || '').trim()] || '';
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
