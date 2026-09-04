import config from '../../config.js';
import {
  resolveDefaultGeminiPrimaryTimeoutMs,
  resolveGeminiAttemptTimeoutMs,
} from '../../config/geminiModels.js';
import {
  isValidCharacterName,
  normalizeCharacterName,
  normalizeNameKey,
} from '../../utils/names.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { createLruTtlCache } from '../../utils/cache/lruTtlCache.js';
import { fetchNameSuggestions } from '../roster/search.js';
import { stripDiacritics } from './nameRecovery.js';

const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GEMINI_INLINE_REQUEST_BYTES = 20 * 1024 * 1024;
const GEMINI_REQUEST_TIMEOUT_MS = 30_000;
// Gemini 3.6+ deprecated the legacy sampling knobs. OCR is a bounded extraction
// task, so low thinking preserves the glyph-reading benefit without letting
// hidden reasoning consume the compact response budget. JSON mode also avoids
// spending tokens on markdown fences or prose around the requested payload.
const GEMINI_GENERATION_CONFIG = Object.freeze({
  maxOutputTokens: config.geminiMaxOutputTokens,
  responseMimeType: 'application/json',
  thinkingConfig: Object.freeze({ thinkingLevel: 'low' }),
});
const GEMINI_FAILOVER_HTTP_STATUSES = new Set([404, 429, 500, 502, 503, 504]);
const MAX_GEMINI_MODEL_COOLDOWN_MS = 5 * 60_000;
const GEMINI_FAILOVER_BODY_HINTS = Object.freeze([
  'resource_exhausted',
  'quota',
  'rate limit',
  'too many requests',
  'is not found',
]);

const GEMINI_FAILURE_FORMATTERS = {
  network: (result) =>
    `Gemini request failed on ${result.model}: ${result.error.message}`,
  http: (result) =>
    `Gemini request failed on ${result.model} (HTTP ${result.status}) ${result.bodyText}`.trim(),
  'response:non-JSON response': () => 'Gemini did not return a JSON array.',
  'response:max output tokens': () => 'Gemini output was truncated at the token limit.',
  cooldown: (result) => (
    `All Gemini models are temporarily cooling down; retry in ${Math.ceil(result.retryAfterMs / 1000)}s.`
  ),
  default: (result) => `All Gemini models failed: ${result.failures.join(' | ')}`,
};

// Process-local circuit breaker. Recoverable model failures should influence
// the next Discord request, not force every user to knock on the same busy
// endpoint again until the deployment restarts.
const geminiModelCooldowns = new Map();

function formatGeminiFailure(result) {
  const key = result.type === 'response'
    ? `${result.type}:${result.reason}`
    : result.type;
  return (GEMINI_FAILURE_FORMATTERS[key] || GEMINI_FAILURE_FORMATTERS.default)(result);
}

/** Known Lost Ark server/world names to filter from OCR results */
const SERVER_NAMES = new Set([
  'azena', 'avesta', 'galatur', 'karta', 'ladon', 'kharmine',
  'una', 'regulus', 'sasha', 'vykas', 'elgacia', 'thaemine',
  'brelshaza', 'kazeros', 'arcturus', 'enviska', 'valtan', 'mari',
  'akkan', 'vairgrys', 'bergstrom', 'danube', 'mokoko',
]);

const ocrCache = createLruTtlCache({
  ttlMs: () => config.ocrCacheTtlMs,
  maxSize: () => config.ocrCacheMaxSize,
  cloneValue: (names) => [...names],
});

function getCachedOcrNames(cacheKey) {
  return ocrCache.get(cacheKey);
}

function setCachedOcrNames(cacheKey, names) {
  if (!Array.isArray(names)) return;
  ocrCache.set(cacheKey, names);
}

/**
 * Drop every cached OCR result. Wired into the test suite so successive
 * tests start from a clean slate; production code never calls this · the
 * cache TTLs + LRU eviction handle steady-state churn.
 * @returns {void}
 */
export function clearOcrCache() {
  ocrCache.clear();
}

/** Gemini OCR prompt for Lost Ark waiting room screenshots */
const GEMINI_PROMPT = [
  'This is a screenshot of a Lost Ark raid waiting room (party finder lobby).',
  'Extract ALL player character names from the party member list, regardless of color.',
  'Ignore all other text: raid names, class names, item levels, buttons, chat messages, server/world names (e.g. Vairgrys, Brelshaza, Thaemine).',
  'Preserve every character exactly as shown, including special letters and diacritics.',
  'Letter count must match the image exactly. Do NOT double letters that appear once (e.g., a name shown as "Trumfighter" must not be returned as "Trumffighter"). Do NOT collapse a run of repeated letters: count each glyph in the run individually (e.g., a name with three i in a row like "Lpiiiv" must keep all three, not two; "Aaaron" keeps all three a).',
  'Lost Ark character names do not contain spaces; if letters appear as one character name, return them as one continuous string.',
  'Look-alike characters: distinguish lowercase L (l), uppercase i (I), and digit 1 (1) by context. Distinguish digit 0 (0) from uppercase O (O).',
  'Lowercase letter pairs that lobby fonts can blur are NOT interchangeable: a vs e, a vs o, c vs e, u vs v, rn vs m. Pick the letter whose silhouette actually matches the pixel cluster · a has a closed bowl, e has a horizontal crossbar, o is fully round.',
  'Lost Ark names frequently use diacritics: ë, ï, ö, ü, í, é, à, è, ì, á, é, â, î. Pay close attention to dots/marks above letters.',
  'Accent direction matters because different players can have the same base letters: acute rises to the right (á, é, í), grave falls to the right (à, è, ì). Do NOT swap acute and grave. Example: Aürélià is not Aüreliá, Aürélía, or Aürélia.',
  'Keep umlaut letters exactly: ë, ö, ü.',
  'Do NOT convert umlauts to grave-accent letters: ë!=è, ö!=ò, ü!=ù.',
  'If a mark looks like two horizontal dots above a letter, treat it as an umlaut on that letter, not as punctuation.',
  'Return JSON array only, no markdown, no explanation.',
  'Example output: ["name1","name2"].',
  'If no valid names are found, return [].',
].join(' ');

// ─── Gemini OCR ─────────────────────────────────────────────────────────────

function shouldFailoverGeminiModel(status, bodyText) {
  // Auth and malformed-request failures stay terminal: replaying the same bad
  // request across every model only adds latency and burns quota.
  if (GEMINI_FAILOVER_HTTP_STATUSES.has(status)) return true;
  const text = (bodyText || '').toLowerCase();
  return GEMINI_FAILOVER_BODY_HINTS.some((hint) => text.includes(hint));
}

function createGeminiRequestBody(prompt, imageBase64, mimeType) {
  return {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: GEMINI_GENERATION_CONFIG,
  };
}

function extractGeminiResponse(payload) {
  const candidate = payload?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((part) => !part.thought)
    .map((part) => part?.text ?? '')
    .join('')
    .trim();

  return {
    finishReason: candidate?.finishReason,
    text,
    usageMetadata: payload?.usageMetadata,
  };
}

function formatGeminiTokenUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== 'object') return '';
  const fields = [
    ['prompt', usageMetadata.promptTokenCount],
    ['output', usageMetadata.candidatesTokenCount],
    ['thoughts', usageMetadata.thoughtsTokenCount],
    ['total', usageMetadata.totalTokenCount],
  ].filter(([, value]) => Number.isFinite(value));
  if (fields.length === 0) return '';
  return `, tokens: ${fields.map(([label, value]) => `${label}=${value}`).join(' ')}`;
}

function parseRetryAfterMs(value, now = Date.now()) {
  const text = String(value || '').trim();
  if (!text) return 0;

  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);

  const retryAt = Date.parse(text);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : 0;
}

function selectAvailableGeminiModels(models, now = Date.now()) {
  const available = [];
  const skipped = [];

  for (const model of models) {
    const key = model.toLowerCase();
    const state = geminiModelCooldowns.get(key);
    if (!state || state.until <= now) {
      if (state) geminiModelCooldowns.delete(key);
      available.push(model);
      continue;
    }

    skipped.push({
      model,
      reason: state.reason,
      remainingMs: state.until - now,
    });
  }

  return { available, skipped };
}

function createGeminiFailureError(result, models) {
  const error = new Error(formatGeminiFailure(result));
  let retryAfterMs = Number(result?.retryAfterMs);

  // A request can start with available models and still finish after every one
  // has entered the process-local circuit breaker. Preserve that state on the
  // thrown error so the batch coordinator can wait once instead of sending the
  // next attachment into a guaranteed zero-attempt failure.
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    const { available, skipped } = selectAvailableGeminiModels(models);
    if (available.length === 0 && skipped.length > 0) {
      retryAfterMs = Math.min(...skipped.map((item) => item.remainingMs));
    }
  }

  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    error.code = 'GEMINI_MODELS_COOLING_DOWN';
    error.retryAfterMs = Math.ceil(retryAfterMs);
  }
  return error;
}

function coolDownGeminiModel(model, reason, retryAfterMs = 0, now = Date.now()) {
  const configuredMs = Math.max(1, config.geminiModelCooldownMs || 60_000);
  const cooldownMs = Math.min(
    Math.max(configuredMs, retryAfterMs),
    Math.max(configuredMs, MAX_GEMINI_MODEL_COOLDOWN_MS),
  );
  geminiModelCooldowns.set(model.toLowerCase(), {
    reason,
    until: now + cooldownMs,
  });
  return cooldownMs;
}

function restoreGeminiModel(model) {
  geminiModelCooldowns.delete(model.toLowerCase());
}

/** Reset only adaptive model health; used by deterministic tests. */
export function clearGeminiModelCooldowns() {
  geminiModelCooldowns.clear();
}

async function requestGeminiWithFallback({
  prompt,
  imageBase64,
  mimeType,
  models: configuredModels,
  parseResponse,
  onModelStart = () => {},
  onModelElapsed = () => {},
  onModelUsage = () => {},
  onModelSkipped = () => {},
  onRetry = () => {},
}) {
  // Inline images can approach Gemini's request limit. Serialize once so each
  // model fallback reuses the same large string instead of reallocating it.
  const requestBody = JSON.stringify(createGeminiRequestBody(prompt, imageBase64, mimeType));
  if (Buffer.byteLength(requestBody, 'utf8') >= MAX_GEMINI_INLINE_REQUEST_BYTES) {
    throw new Error('Gemini inline request too large (must be under 20MB including encoding).');
  }
  const { available: models, skipped } = selectAvailableGeminiModels(configuredModels);
  for (const skippedModel of skipped) onModelSkipped(skippedModel);

  if (models.length === 0) {
    const retryAfterMs = Math.min(...skipped.map((item) => item.remainingMs));
    return {
      ok: false,
      type: 'cooldown',
      retryAfterMs,
      failures: skipped.map((item) => `${item.model}: cooldown (${item.reason})`),
    };
  }

  const failures = [];
  // Failover models share one wall-clock budget. A hung primary must not get
  // a fresh 30 seconds for every fallback in the chain; quick 404/429/5xx
  // responses still leave almost the full budget for the next model.
  const requestSignal = AbortSignal.timeout(GEMINI_REQUEST_TIMEOUT_MS);
  const requestDeadline = Date.now() + GEMINI_REQUEST_TIMEOUT_MS;
  // Keep one more model reachable after quick recoverable failures. Once an
  // attempt actually times out, the next model may use the remainder because
  // that timeout already consumed the protected portion of the deadline.
  let protectNextFallback = true;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const hasFallback = i < models.length - 1;
    const remainingMs = Math.max(0, requestDeadline - Date.now());
    if (remainingMs === 0 || requestSignal.aborted) {
      const error = requestSignal.reason || new DOMException('Gemini request timed out.', 'TimeoutError');
      return { ok: false, type: 'network', model, error, failures };
    }

    const preferredModelTimeoutMs = i === 0 && config.geminiPrimaryTimeoutOverridden
      ? config.geminiPrimaryTimeoutMs
      : resolveDefaultGeminiPrimaryTimeoutMs(model);
    // Every model keeps its model-aware cap. A promoted fallback must not take
    // the entire shared deadline merely because the previous model returned a
    // quick 429/503; that would prevent the next healthy model from running.
    const modelTimeoutMs = Math.min(
      preferredModelTimeoutMs || 8_000,
      remainingMs,
    );
    const shouldProtectFallback = protectNextFallback && hasFallback;
    const attemptTimeoutMs = resolveGeminiAttemptTimeoutMs({
      remainingMs,
      modelTimeoutMs,
      fallbackReserveMs: config.geminiFallbackReserveMs || 10_000,
      hasFallback: shouldProtectFallback,
    });
    // Quick recoverable failures keep producing soft deadlines. A real timeout
    // flips protectNextFallback off so the promoted model receives whatever is
    // left under the one shared hard deadline.
    const modelSignal = attemptTimeoutMs < remainingMs
      ? AbortSignal.any([requestSignal, AbortSignal.timeout(attemptTimeoutMs)])
      : requestSignal;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const modelStartedAt = Date.now();
    onModelStart(model);

    let aiRes;
    try {
      aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: requestBody,
        signal: modelSignal,
      });
    } catch (error) {
      onModelElapsed({ model, elapsedMs: Date.now() - modelStartedAt });
      failures.push(`${model}: ${error.name || error.message}`);
      const cooldownMs = coolDownGeminiModel(
        model,
        modelSignal.aborted ? 'timeout' : 'network error',
      );
      if (requestSignal.aborted) {
        return { ok: false, type: 'network', model, error, failures };
      }
      if (modelSignal.aborted && hasFallback) {
        protectNextFallback = false;
        onRetry({ type: 'timeout', model, error, timeoutMs: attemptTimeoutMs, cooldownMs });
        continue;
      }
      if (hasFallback) {
        protectNextFallback = true;
        onRetry({ type: 'network', model, error, cooldownMs });
        continue;
      }
      return { ok: false, type: 'network', model, error, failures };
    }
    onModelElapsed({ model, elapsedMs: Date.now() - modelStartedAt });

    if (!aiRes.ok) {
      const bodyText = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);
      const recoverable = shouldFailoverGeminiModel(aiRes.status, bodyText);
      if (recoverable) {
        const retryAfterMs = parseRetryAfterMs(aiRes.headers.get('retry-after'));
        const cooldownMs = coolDownGeminiModel(
          model,
          `HTTP ${aiRes.status}`,
          retryAfterMs,
        );
        if (hasFallback) {
          protectNextFallback = true;
          onRetry({ type: 'http', model, status: aiRes.status, bodyText, cooldownMs });
          continue;
        }
      }
      return {
        ok: false,
        type: 'http',
        model,
        status: aiRes.status,
        bodyText,
        failures,
      };
    }

    const payload = await aiRes.json();
    onModelUsage(payload?.usageMetadata);
    const parsed = await parseResponse({
      ...extractGeminiResponse(payload),
      model,
      hasFallback,
    });
    if (parsed?.retry === true) {
      failures.push(`${model}: ${parsed.reason}`);
      if (hasFallback) {
        protectNextFallback = true;
        continue;
      }
      return {
        ok: false,
        type: 'response',
        model,
        reason: parsed.reason,
        failures,
      };
    }

    restoreGeminiModel(model);
    return { ok: true, value: parsed?.value, model, failures };
  }

  return { ok: false, type: 'exhausted', failures };
}

function filterAndDeduplicateNames(parsed) {
  const seen = new Set();
  const unique = [];
  for (const item of parsed || []) {
    if (typeof item !== 'string') continue;
    const name = normalizeCharacterName(item);
    const key = normalizeNameKey(name);
    if (!isValidCharacterName(name) || SERVER_NAMES.has(key) || seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return unique;
}

async function findAmbiguousOcrChoices(
  names,
  { suggestionCache, suggestionContext } = {},
) {
  const concurrency = config.listcheckRosterLookupConcurrency || 3;
  const lookupTimeoutMs = config.listcheckRosterLookupTimeoutMs || 6000;
  // One absolute deadline bounds the whole candidate-discovery phase. Without
  // it, eight slow names at concurrency 3 could restart the timeout in three
  // waves, and each direct failure could restart it again through ScraperAPI.
  const lookupSignal = AbortSignal.timeout(lookupTimeoutMs);
  const choices = await mapWithConcurrency(names, concurrency, async (name) => {
    // Workers may still have queued names after the shared deadline expires.
    // Skip those locally instead of creating already-aborted HTTP requests.
    if (lookupSignal.aborted) return null;

    let suggestions;
    try {
      suggestions = await fetchNameSuggestions(name, {
        timeoutMs: lookupTimeoutMs,
        signal: lookupSignal,
        suggestionCache,
        suggestionContext,
      });
    } catch (err) {
      console.warn(`[listcheck] OCR refine search skipped for ${name}: ${err.message}`);
      return null;
    }
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

    // A wrong mark can be just as dangerous as a dropped mark: the OCR result
    // may exactly spell a different real character (ü -> ú/ù/ï). Collect every
    // Bible identity with the same ASCII base and let the second vision pass
    // decide from the glyphs, never from search ordering or item level.
    const base = stripDiacritics(name);
    const candidatesByKey = new Map();
    for (const suggestion of suggestions) {
      const candidate = normalizeCharacterName(suggestion?.name);
      if (!candidate || stripDiacritics(candidate) !== base) continue;
      candidatesByKey.set(normalizeNameKey(candidate), candidate);
    }
    if (candidatesByKey.size < 2) return null;

    const nameKey = normalizeNameKey(name);
    const alternatives = [...candidatesByKey.entries()]
      .filter(([candidateKey]) => candidateKey !== nameKey)
      .map(([, candidate]) => candidate);
    if (alternatives.length === 0) return null;
    return {
      original: name,
      // The original is always the safe fallback when the dots/accents are not
      // legible enough. It need not be a Bible result: a later verification
      // stage will reject it instead of forcing one of the alternatives.
      candidates: [name, ...alternatives],
    };
  });

  return choices.filter(Boolean);
}

async function requestGeminiObject(prompt, imageBase64, mimeType, models) {
  const result = await requestGeminiWithFallback({
    prompt,
    imageBase64,
    mimeType,
    models,
    parseResponse: ({ text }) => {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { retry: true, reason: 'non-JSON object' };

      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          value: parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null,
        };
      } catch {
        return { retry: true, reason: 'invalid JSON object' };
      }
    },
  });

  if (!result.ok && result.type !== 'http') {
    console.warn(`[listcheck] OCR ambiguity refinement failed: ${result.failures.join(' | ')}`);
  }
  return result.ok ? result.value : null;
}

async function refineAmbiguousOcrNames(
  names,
  { imageBase64, mimeType, models, suggestionCache, suggestionContext } = {},
) {
  // Keep overflow names for the ignored-count UI, but avoid spending HTTP
  // calls on rows that cannot enter the bounded list-check pipeline.
  const refineLimit = config.listcheckMaxNames || names.length;
  const choices = await findAmbiguousOcrChoices(
    names.slice(0, refineLimit),
    { suggestionCache, suggestionContext },
  );
  if (choices.length === 0) return names;

  const choiceLines = choices
    .map((choice) => `- ${JSON.stringify(choice.original)}: ${choice.candidates.map((c) => JSON.stringify(c)).join(', ')}`)
    .join('\n');

  const prompt = [
    'This is a targeted correction pass for Lost Ark raid lobby OCR.',
    'The first OCR pass may have DROPPED, ADDED, or CONFUSED visible diacritics in character names.',
    'Inspect only the visible player-name text in the image. Do not choose by item level, class, roster popularity, or search ranking.',
    'For each key below, choose exactly one candidate from its candidate list. If the visible glyphs are unclear, keep the original key.',
    'Pay special attention to two-dot umlauts and distinguish ü/ö/ï/ë from plain, acute, and grave-accent forms.',
    'Return a JSON object only, mapping each original key to the chosen candidate.',
    'Candidates:',
    choiceLines,
  ].join('\n');

  const resolved = await requestGeminiObject(prompt, imageBase64, mimeType, models);
  if (!resolved) return names;

  const allowed = new Map(choices.map((choice) => [choice.original, new Set(choice.candidates)]));
  return names.map((name) => {
    const raw = typeof resolved[name] === 'string' ? normalizeCharacterName(resolved[name]) : '';
    if (!raw || !allowed.get(name)?.has(raw)) return name;
    if (raw !== name) {
      console.log(`[listcheck] OCR targeted diacritic correction: "${name}" -> "${raw}"`);
    }
    return raw;
  });
}

/**
 * Extract character names from an image using Gemini OCR.
 * Fails over on model availability, quota/rate limits, transient upstream
 * failures, network errors, and structurally unusable responses.
 *
 * @param {object} image - Discord attachment or { url, contentType }
 * @param {object} [options]
 * @param {'daily'|'analysis'} [options.mode='daily'] - isolated model chain for this request and its refinement pass
 * @param {boolean} [options.refineAmbiguousDiacritics=false] - second-pass OCR for names with multiple same-base Bible spellings
 * @param {Map} [options.suggestionCache] - request-local Bible search cache
 * @param {object} [options.suggestionContext] - request-wide Bible lookup budget and metrics
 * @returns {Promise<string[]>} Array of normalized character names
 */
export async function extractNamesFromImage(image, options = {}) {
  const startedAt = Date.now();
  const timing = {
    mode: options.mode ?? 'daily',
    cache: 'miss',
    status: 'error',
    model: 'none',
    names: 0,
    downloadMs: 0,
    geminiMs: 0,
    geminiAttempts: 0,
    modelTimings: [],
    refineMs: 0,
    promptTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
  };

  try {
  const mode = timing.mode;
  if (mode !== 'daily' && mode !== 'analysis') {
    throw new RangeError(`Unknown OCR mode: ${mode}`);
  }
  const models = mode === 'analysis' ? config.geminiAnalysisModels : config.geminiModels;
  if (models.length === 0) throw new Error(`No Gemini models are enabled for OCR mode: ${mode}`);
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (image.contentType && !image.contentType.startsWith('image/')) {
    throw new Error('Attachment must be an image file.');
  }

  const refineAmbiguousDiacritics = options.refineAmbiguousDiacritics === true;
  // A deeper retry must not reuse a daily answer for the same attachment.
  const cacheKey = image.url
    ? `${image.url}|mode:${mode}|models:${models.join(',')}|refine:${refineAmbiguousDiacritics ? '1' : '0'}`
    : '';
  const cachedNames = getCachedOcrNames(cacheKey);
  if (cachedNames !== undefined) {
    timing.cache = 'hit';
    timing.status = 'ok';
    timing.names = cachedNames.length;
    return cachedNames;
  }

  const downloadStartedAt = Date.now();
  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  timing.downloadMs = Date.now() - downloadStartedAt;
  if (!imageRes.ok) {
    throw new Error(`Failed to download attachment (HTTP ${imageRes.status})`);
  }

  const contentLength = imageRes.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_OCR_IMAGE_BYTES) {
    throw new Error('Image file too large (max 20MB).');
  }

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  timing.downloadMs = Date.now() - downloadStartedAt;
  if (imageBuffer.byteLength > MAX_OCR_IMAGE_BYTES) {
    throw new Error('Image file too large (max 20MB).');
  }
  const imageBase64 = imageBuffer.toString('base64');

  const geminiResult = await requestGeminiWithFallback({
    prompt: GEMINI_PROMPT,
    imageBase64,
    mimeType,
    models,
    onModelStart: (model) => {
      timing.model = model;
      timing.geminiAttempts += 1;
    },
    onModelElapsed: ({ model, elapsedMs }) => {
      timing.geminiMs += elapsedMs;
      timing.modelTimings.push(`${model}:${elapsedMs}ms`);
    },
    onModelUsage: (usageMetadata = {}) => {
      const tokenFields = [
        ['promptTokens', usageMetadata.promptTokenCount],
        ['outputTokens', usageMetadata.candidatesTokenCount],
        ['thoughtTokens', usageMetadata.thoughtsTokenCount],
        ['totalTokens', usageMetadata.totalTokenCount],
      ];
      for (const [field, value] of tokenFields) {
        if (Number.isFinite(value)) timing[field] += value;
      }
    },
    onModelSkipped: ({ model, reason, remainingMs }) => {
      console.warn(
        `[listcheck] Gemini ${model} cooling down after ${reason};`
        + ` skipping for ${Math.ceil(remainingMs / 1000)}s.`,
      );
    },
    onRetry: ({ type, model, status, timeoutMs, cooldownMs }) => {
      const cooldown = Number.isFinite(cooldownMs)
        ? ` Cooling it down for ${Math.ceil(cooldownMs / 1000)}s.`
        : '';
      const retryMessages = {
        network: `[listcheck] Gemini timeout/network error on ${model}, trying fallback model.${cooldown}`,
        timeout: `[listcheck] Gemini model ${model} exceeded ${timeoutMs}ms, trying fallback model.${cooldown}`,
        http: `[listcheck] Gemini recoverable HTTP ${status} on ${model}, trying fallback model.${cooldown}`,
      };
      if (retryMessages[type]) console.warn(retryMessages[type]);
    },
    parseResponse: ({ finishReason, text, model, usageMetadata }) => {
      if (finishReason && finishReason !== 'STOP') {
        console.warn(
          `[listcheck] Gemini (${model}) finishReason: ${finishReason}`
          + `${formatGeminiTokenUsage(usageMetadata)}, text: ${text.slice(0, 100)}`,
        );
      }

      // A syntactically closed array can still be only the prefix of the lobby
      // when generation hit its ceiling. Never accept it as a complete roster.
      if (finishReason === 'MAX_TOKENS') {
        return { retry: true, reason: 'max output tokens' };
      }

      if (!text) return { value: { parsed: [], emptyResponse: true } };

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn(`[listcheck] Gemini (${model}) returned non-JSON text: ${text.slice(0, 200)}`);
        return { retry: true, reason: 'non-JSON response' };
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.warn(`[listcheck] Gemini (${model}) JSON parse failed: ${jsonMatch[0].slice(0, 200)}`);
        throw new Error('Gemini returned invalid JSON.');
      }
      if (!Array.isArray(parsed)) throw new Error('Gemini output is not an array.');
      return { value: { parsed, emptyResponse: false } };
    },
  });

  if (!geminiResult.ok) {
    throw createGeminiFailureError(geminiResult, models);
  }

  if (geminiResult.value.emptyResponse) {
    timing.status = 'ok';
    return [];
  }

  let names = filterAndDeduplicateNames(geminiResult.value.parsed);
  if (refineAmbiguousDiacritics) {
    const refineStartedAt = Date.now();
    try {
      names = await refineAmbiguousOcrNames(names, {
        imageBase64,
        mimeType,
        models,
        suggestionCache: options.suggestionCache,
        suggestionContext: options.suggestionContext,
      });
    } finally {
      timing.refineMs = Date.now() - refineStartedAt;
    }
    // Two distinct OCR strings may converge on the same Bible-confirmed name.
    // Collapse them before caching so the shared check pipeline never repeats
    // Mongo/enrichment/render work for one character.
    names = filterAndDeduplicateNames(names);
  }
  setCachedOcrNames(cacheKey, names);
  timing.status = 'ok';
  timing.names = names.length;
  return names;
  } finally {
    const lookupStats = options.suggestionContext?.stats || {};
    console.log([
      `[listcheck] OCR timing total=${Date.now() - startedAt}ms`,
      `status=${timing.status}`,
      `cache=${timing.cache}`,
      `download=${timing.downloadMs}ms`,
      `gemini=${timing.geminiMs}ms`,
      `attempts=${timing.geminiAttempts}`,
      `modelTimings=${timing.modelTimings.join(',') || 'none'}`,
      `refine=${timing.refineMs}ms`,
      `model=${timing.model}`,
      `mode=${timing.mode}`,
      `names=${timing.names}`,
      `promptTokens=${timing.promptTokens}`,
      `outputTokens=${timing.outputTokens}`,
      `thoughtTokens=${timing.thoughtTokens}`,
      `totalTokens=${timing.totalTokens}`,
      `searchNetwork=${lookupStats.networkLookups || 0}`,
      `searchRequestCache=${lookupStats.requestCacheHits || 0}`,
      `searchSharedCache=${lookupStats.sharedCacheHits || 0}`,
      `searchBudgetExhausted=${lookupStats.budgetExhaustions || 0}`,
    ].join(' '));
  }
}
