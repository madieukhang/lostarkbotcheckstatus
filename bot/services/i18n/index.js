import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  TRANSLATIONS,
} from '../../locales/index.js';

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((entry) => entry.code));
const KNOWN_LOCALE_CODES = new Set(Object.keys(TRANSLATIONS));
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
  if (Array.isArray(template)) {
    return template.map((item) => applyVars(item, vars));
  }
  if (template && typeof template === 'object') {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [key, applyVars(value, vars)])
    );
  }
  if (typeof template !== 'string' || !vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
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

export async function getGuildLanguage(guildId, { GuildConfigModel } = {}) {
  if (!guildId) return DEFAULT_LANGUAGE;
  if (guildLanguageCache.has(guildId)) return guildLanguageCache.get(guildId);
  if (!GuildConfigModel) return DEFAULT_LANGUAGE;

  try {
    const doc = await GuildConfigModel.findOne({ guildId }, { language: 1 }).lean();
    const lang = normalizeLanguage(doc?.language);
    guildLanguageCache.set(guildId, lang);
    return lang;
  } catch {
    return DEFAULT_LANGUAGE;
  }
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

export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, TRANSLATIONS };
