import en from './en.js';
import jp from './jp.js';
import vi from './vi.js';

function mergeLocale(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }
  if (!base || typeof base !== 'object' || !override || typeof override !== 'object') {
    return override ?? base;
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeLocale(base[key], value);
  }
  return merged;
}

export const TRANSLATIONS = {
  en,
  vi: mergeLocale(en, vi),
  jp: mergeLocale(en, jp),
};

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'vi', label: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'jp', label: '日本語', flag: '🇯🇵' },
];

export const DEFAULT_LANGUAGE = 'en';
