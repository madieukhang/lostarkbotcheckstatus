// Ordered newest-to-oldest: OCR walks this chain only when the current model
// is unavailable, rate-limited, or returns an unusable response.
export const DEFAULT_GEMINI_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

// Keep slow or temporarily unhealthy models available in the catalog without
// sending production OCR traffic to them. Clear GEMINI_MODEL_WAITLIST to
// restore the full configured chain.
export const DEFAULT_GEMINI_MODEL_WAITLIST = Object.freeze([
  'gemini-3.8-flash',
]);

const DEFAULT_PRIMARY_TIMEOUT_MS_BY_MODEL = Object.freeze({
  'gemini-3.8-flash': 8_000,
  'gemini-3.7-flash': 15_000,
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
