import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  TRANSLATIONS,
} from '../../locales/index.js';

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((entry) => entry.code));
const KNOWN_LOCALE_CODES = new Set(Object.keys(TRANSLATIONS));
const userLanguageCache = new Map();
const guildLanguageCache = new Map();

export function normalizeLanguage(value) {
  const code = typeof value === 'string' ? value.toLowerCase() : '';
  return SUPPORTED_CODES.has(code) ? code : DEFAULT_LANGUAGE;
}

export function resolveLocale(value) {
  const code = typeof value === 'string' ? value.toLowerCase() : '';
  return KNOWN_LOCALE_CODES.has(code) ? code : DEFAULT_LANGUAGE;
}

export function getSupportedLanguages() {
  return SUPPORTED_LANGUAGES;
}

function lookupKey(tree, dottedKey) {
  if (!tree || typeof dottedKey !== 'string') return undefined;
  const segments = dottedKey.split('.');
  let cursor = tree;
  for (const segment of segments) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function applyVars(template, vars) {
  const templateType = Array.isArray(template) ? 'array' : typeof template;
  switch (templateType) {
    case 'array':
      return template.map((item) => applyVars(item, vars));
    case 'object':
      return template
        ? Object.fromEntries(
            Object.entries(template).map(([key, value]) => [key, applyVars(value, vars)])
          )
        : template;
    case 'string':
      return vars
        ? template.replace(/\{(\w+)\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
          ))
        : template;
    default:
      return template;
  }
}

export function t(key, lang = DEFAULT_LANGUAGE, vars = null) {
  const code = resolveLocale(lang);
  const primary = lookupKey(TRANSLATIONS[code], key);
  if (primary != null) return applyVars(primary, vars);
  if (code !== DEFAULT_LANGUAGE) {
    const fallback = lookupKey(TRANSLATIONS[DEFAULT_LANGUAGE], key);
    if (fallback != null) return applyVars(fallback, vars);
  }
  return key;
}

/**
 * Resolve a key that MAY carry several phrasings, picking one at random.
 *
 * A pool is an object `{ variants: [...] }` - never a bare array. Bare arrays
 * already mean "multi-line block" in these locales (the welcome-pin fields and
 * help groups are arrays joined with a newline), so treating any array as a
 * pool would silently render one random line out of a paragraph.
 *
 * Non-pool keys pass straight through to t(), so tPick is a safe drop-in and
 * pools can be introduced one call site at a time.
 *
 *   tPick('dialogue.check.done', 'en')                  -> a random phrasing
 *   tPick('dialogue.check.done', 'en', null, {index: 2}) -> the 3rd, always
 *
 * @param {string} key - dotted translation key
 * @param {string} [lang] - locale code; falls back like t()
 * @param {Object|null} [vars] - {name} interpolation values
 * @param {{index?: number, random?: () => number}} [opts] - deterministic
 *   selection for tests: `index` wins, else `random` (defaults to Math.random)
 * @returns {string|string[]} the chosen variant, or t()'s result verbatim
 */
export function tPick(key, lang = DEFAULT_LANGUAGE, vars = null, opts = {}) {
  const code = resolveLocale(lang);
  const raw = lookupKey(TRANSLATIONS[code], key)
    ?? (code !== DEFAULT_LANGUAGE ? lookupKey(TRANSLATIONS[DEFAULT_LANGUAGE], key) : undefined);

  const pool = raw && !Array.isArray(raw) && typeof raw === 'object' && Array.isArray(raw.variants)
    ? raw.variants
    : null;
  if (!pool || pool.length === 0) return t(key, lang, vars);

  const index = Number.isInteger(opts.index)
    ? ((opts.index % pool.length) + pool.length) % pool.length
    : Math.floor((opts.random || Math.random)() * pool.length);
  return applyVars(pool[index], vars);
}

function buildUserPreferenceSet(user, language) {
  return Object.fromEntries([
    ['language', language],
    ['discordUsername', user?.username],
    ['discordGlobalName', user?.globalName],
    ['discordDisplayName', user?.displayName],
  ].filter(([, value]) => Boolean(value)));
}

async function getStoredLanguage(id, { cache, Model, idField }) {
  const cached = id ? cache.get(id) : undefined;
  if (!id || cached || !Model) return cached || DEFAULT_LANGUAGE;

  try {
    const doc = await Model.findOne({ [idField]: id }, { language: 1 }).lean();
    const lang = normalizeLanguage(doc?.language);
    cache.set(id, lang);
    return lang;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export async function getUserLanguage(discordId, { UserPreferenceModel } = {}) {
  return getStoredLanguage(discordId, {
    cache: userLanguageCache,
    Model: UserPreferenceModel,
    idField: 'discordId',
  });
}

export function getCachedUserLanguage(discordId) {
  if (!discordId) return DEFAULT_LANGUAGE;
  return userLanguageCache.get(discordId) || DEFAULT_LANGUAGE;
}

export async function setUserLanguage(discordId, lang, { UserPreferenceModel, user } = {}) {
  const code = normalizeLanguage(lang);
  if (!discordId) return code;

  if (UserPreferenceModel) {
    await UserPreferenceModel.updateOne(
      { discordId },
      { $set: buildUserPreferenceSet(user, code), $setOnInsert: { discordId } },
      { upsert: true }
    );
  }

  userLanguageCache.set(discordId, code);
  return code;
}

export function clearUserLanguageCache() {
  userLanguageCache.clear();
}

export async function getGuildLanguage(guildId, { GuildConfigModel } = {}) {
  return getStoredLanguage(guildId, {
    cache: guildLanguageCache,
    Model: GuildConfigModel,
    idField: 'guildId',
  });
}

export async function setGuildLanguage(guildId, lang, { GuildConfigModel } = {}) {
  const code = normalizeLanguage(lang);
  if (!guildId) return code;

  if (GuildConfigModel) {
    await GuildConfigModel.updateOne(
      { guildId },
      { $set: { language: code }, $setOnInsert: { guildId } },
      { upsert: true }
    );
  }

  guildLanguageCache.set(guildId, code);
  return code;
}

export function clearGuildLanguageCache() {
  guildLanguageCache.clear();
}
