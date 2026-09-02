export const DEFAULT_GEMINI_MODELS = Object.freeze([
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]);

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
