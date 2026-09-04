// Full catalog; runtime requests select one profile instead of walking every
// model for a routine screenshot.
export const DEFAULT_GEMINI_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

export const GEMINI_MODEL_PROFILES = Object.freeze({
  daily: Object.freeze(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']),
  analysis: Object.freeze(DEFAULT_GEMINI_MODELS.filter((model) => !model.endsWith('-lite'))),
});

// Explicit operator waitlists still apply to both profiles. 3.8 is available
// again for analysis, while daily traffic stays on the two Flash-Lite models.
export const DEFAULT_GEMINI_MODEL_WAITLIST = Object.freeze([]);

const DEFAULT_PRIMARY_TIMEOUT_MS_BY_MODEL = Object.freeze({
  'gemini-3.8-flash': 8_000,
  'gemini-3.7-flash': 30_000,
});

export function isGemini3Model(model) {
  return /^gemini-3(?:[.-]|$)/i.test(String(model || '').trim());
}

/**
 * Resolve the optional env override while enforcing the 3.x-only contract.
 * If no usable 3.x model remains, fall back to the stable default chain.
 */
export function resolveGeminiModels(rawValue = '') {
  const requested = String(rawValue || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const models = [];
  const rejected = [];
  const seen = new Set();

  for (const model of requested) {
    if (!isGemini3Model(model)) {
      rejected.push(model);
      continue;
    }
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }

  return {
    models: models.length > 0 ? models : [...DEFAULT_GEMINI_MODELS],
    rejected,
    usedDefaults: models.length === 0,
  };
}

/**
 * Resolve one OCR profile, retaining the order of an explicit override.
 * Legacy mixed catalogs are partitioned; a missing group uses its own defaults
 * so an analysis-only legacy override cannot route daily traffic to Flash.
 * @param {string} rawValue Optional comma-separated model override.
 * @param {'daily'|'analysis'} profile Requested workload.
 * @returns {{models: string[], rejected: string[], usedDefaults: boolean}}
 */
export function resolveGeminiModelProfile(rawValue = '', profile = 'daily') {
  const defaults = GEMINI_MODEL_PROFILES[profile];
  if (!defaults) throw new RangeError(`Unknown Gemini OCR profile: ${profile}`);
  const resolution = resolveGeminiModels(rawValue);
  const allowed = new Set(defaults);
  const selected = resolution.models.filter((model) => allowed.has(model.toLowerCase()));
  const usedDefaults = resolution.usedDefaults || selected.length === 0;
  return {
    models: usedDefaults ? [...defaults] : selected,
    rejected: resolution.rejected,
    usedDefaults,
  };
}

/**
 * Remove temporarily deferred models after resolving the configured catalog.
 * Matching is case-insensitive, while the active chain preserves its original
 * spelling and order.
 */
export function applyGeminiModelWaitlist(models, rawValue = '') {
  const requested = String(rawValue || '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const waitlistKeys = new Set();
  const rejected = [];

  for (const model of requested) {
    if (['none', 'off'].includes(model.toLowerCase())) continue;
    if (!isGemini3Model(model)) {
      rejected.push(model);
      continue;
    }
    waitlistKeys.add(model.toLowerCase());
  }

  const activeModels = [];
  const waitlisted = [];
  for (const model of models) {
    if (waitlistKeys.has(model.toLowerCase())) waitlisted.push(model);
    else activeModels.push(model);
  }

  return { models: activeModels, waitlisted, rejected };
}

export function resolveDefaultGeminiPrimaryTimeoutMs(model) {
  return DEFAULT_PRIMARY_TIMEOUT_MS_BY_MODEL[String(model || '').toLowerCase()] || 15_000;
}

/**
 * Bound one model attempt while preserving useful time for a fallback.
 * If the shared request is already inside the reserve window, the current
 * model receives the remainder instead of being aborted after a token delay.
 */
export function resolveGeminiAttemptTimeoutMs({
  remainingMs,
  modelTimeoutMs,
  fallbackReserveMs,
  hasFallback,
}) {
  const remaining = Math.max(1, Math.floor(Number(remainingMs) || 0));
  const modelCap = Math.max(1, Math.floor(Number(modelTimeoutMs) || remaining));
  const reserve = Math.max(0, Math.floor(Number(fallbackReserveMs) || 0));
  const availableBeforeReserve = remaining - reserve;
  const canPreserveFallback = hasFallback && reserve > 0 && availableBeforeReserve >= 1_000;

  return Math.min(modelCap, canPreserveFallback ? availableBeforeReserve : remaining);
}
