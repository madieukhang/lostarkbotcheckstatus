import config from '../../config.js';
import {
  isValidCharacterName,
  normalizeCharacterName,
  normalizeNameKey,
} from '../../utils/names.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { createLruTtlCache } from '../../utils/lruTtlCache.js';
import { fetchNameSuggestions } from '../roster/search.js';
import { hasAnyDiacritic, stripDiacritics } from './nameRecovery.js';

const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;
const GEMINI_GENERATION_CONFIG = {
  temperature: 0,
  topP: 0.1,
  maxOutputTokens: 512,
};

const GEMINI_FAILURE_FORMATTERS = {
  network: (result) =>
    `Gemini request failed on ${result.model}: ${result.error.message}`,
  http: (result) =>
    `Gemini request failed on ${result.model} (HTTP ${result.status}) ${result.bodyText}`.trim(),
  'response:non-JSON response': () => 'Gemini did not return a JSON array.',
  default: (result) => `All Gemini models failed: ${result.failures.join(' | ')}`,
};

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
  // 404 = model not found, 429 = rate limit, 503 = overloaded · all should try next model
  if (status === 404 || status === 429 || status === 503) return true;
  const text = (bodyText || '').toLowerCase();
  return (
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('is not found')
  );
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
  };
}

async function requestGeminiWithFallback({
  prompt,
  imageBase64,
  mimeType,
  parseResponse,
  onModelStart = () => {},
  onModelElapsed = () => {},
  onRetry = () => {},
}) {
  const requestBody = createGeminiRequestBody(prompt, imageBase64, mimeType);
  const models = config.geminiModels;
  const failures = [];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const hasFallback = i < models.length - 1;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const modelStartedAt = Date.now();
    onModelStart(model);

    let aiRes;
    try {
      aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      onModelElapsed(Date.now() - modelStartedAt);
      failures.push(`${model}: ${error.name || error.message}`);
      if (hasFallback) {
        onRetry({ type: 'network', model, error });
        continue;
      }
      return { ok: false, type: 'network', model, error, failures };
    }
    onModelElapsed(Date.now() - modelStartedAt);

    if (!aiRes.ok) {
      const bodyText = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);
      if (hasFallback && shouldFailoverGeminiModel(aiRes.status, bodyText)) {
        onRetry({ type: 'http', model, status: aiRes.status, bodyText });
        continue;
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
    const parsed = await parseResponse({
      ...extractGeminiResponse(payload),
      model,
      hasFallback,
    });
    if (parsed?.retry === true) {
      failures.push(`${model}: ${parsed.reason}`);
      if (hasFallback) continue;
      return {
        ok: false,
        type: 'response',
        model,
        reason: parsed.reason,
        failures,
      };
    }

    return { ok: true, value: parsed?.value, model, failures };
  }

  return { ok: false, type: 'exhausted', failures };
}

function filterAndDeduplicateNames(parsed) {
  const names = parsed
    .map((item) => (typeof item === 'string' ? normalizeCharacterName(item) : ''))
    .filter(
      (name) => isValidCharacterName(name) && !SERVER_NAMES.has(normalizeNameKey(name))
    );

  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const key = normalizeNameKey(name);
    if (seen.has(key)) continue;
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
  const choices = await mapWithConcurrency(names, concurrency, async (name) => {
    // This refinement is only for the dangerous case where Gemini
    // dropped a visible mark entirely (e.g. Crüelfighter -> Cruelfighter)
    // and Bible also has a real unmarked character. If the OCR already
    // contains a mark, the normal canonical matcher can rank it safely.
    if (hasAnyDiacritic(name)) return null;

    let suggestions = null;
    try {
      suggestions = await fetchNameSuggestions(name, {
        timeoutMs: 5000,
        suggestionCache,
        suggestionContext,
      });
    } catch (err) {
      console.warn(`[listcheck] OCR refine search skipped for ${name}: ${err.message}`);
      return null;
    }
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

    const nameKey = normalizeNameKey(name);
    const exact = suggestions.find((suggestion) => normalizeNameKey(suggestion.name) === nameKey);
    if (!exact) return null;

    const base = stripDiacritics(name);
    const markedSiblings = suggestions
      .filter((s) => {
        const candidate = String(s.name || '');
        return normalizeNameKey(candidate) !== nameKey
          && stripDiacritics(candidate) === base
          && hasAnyDiacritic(candidate);
      })
      .map((s) => String(s.name));

    if (markedSiblings.length === 0) return null;
    return {
      original: name,
      candidates: [String(exact.name), ...markedSiblings],
    };
  });

  return choices.filter(Boolean);
}

async function requestGeminiObject(prompt, imageBase64, mimeType) {
  const result = await requestGeminiWithFallback({
    prompt,
    imageBase64,
    mimeType,
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
  { imageBase64, mimeType, suggestionCache, suggestionContext } = {},
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
    'The first OCR pass may have DROPPED visible diacritics from character names.',
    'Inspect only the visible player-name text in the image. Do not choose by item level, class, roster popularity, or search ranking.',
    'For each key below, choose exactly one candidate from its candidate list. If the visible glyphs are unclear, keep the original key.',
    'Pay special attention to two-dot umlauts above letters, especially ü versus plain u.',
    'Return a JSON object only, mapping each original key to the chosen candidate.',
    'Candidates:',
    choiceLines,
  ].join('\n');

  const resolved = await requestGeminiObject(prompt, imageBase64, mimeType);
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
 * Handles model failover on quota/rate limits and network errors.
 *
 * @param {object} image - Discord attachment or { url, contentType }
 * @param {object} [options]
 * @param {boolean} [options.refineAmbiguousDiacritics=false] - second-pass OCR for exact unmarked names with marked Bible siblings
 * @param {Map} [options.suggestionCache] - request-local Bible search cache
 * @param {object} [options.suggestionContext] - request-wide Bible lookup budget and metrics
 * @returns {Promise<string[]>} Array of normalized character names
 */
export async function extractNamesFromImage(image, options = {}) {
  const startedAt = Date.now();
  const timing = {
    cache: 'miss',
    status: 'error',
    model: 'none',
    names: 0,
    downloadMs: 0,
    geminiMs: 0,
    refineMs: 0,
  };

  try {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (image.contentType && !image.contentType.startsWith('image/')) {
    throw new Error('Attachment must be an image file.');
  }

  const refineAmbiguousDiacritics = options.refineAmbiguousDiacritics === true;
  const cacheKey = image.url ? `${image.url}|refine:${refineAmbiguousDiacritics ? '1' : '0'}` : '';
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
    onModelStart: (model) => {
      timing.model = model;
    },
    onModelElapsed: (elapsedMs) => {
      timing.geminiMs += elapsedMs;
    },
    onRetry: ({ type, model }) => {
      const retryMessages = {
        network: `[listcheck] Gemini timeout/network error on ${model}, trying fallback model.`,
        http: `[listcheck] Gemini quota/rate hit on ${model}, trying fallback model.`,
      };
      if (retryMessages[type]) console.warn(retryMessages[type]);
    },
    parseResponse: ({ finishReason, text, model }) => {
      if (finishReason && finishReason !== 'STOP') {
        console.warn(`[listcheck] Gemini (${model}) finishReason: ${finishReason}, text: ${text.slice(0, 100)}`);
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
    throw new Error(formatGeminiFailure(geminiResult));
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
        suggestionCache: options.suggestionCache,
        suggestionContext: options.suggestionContext,
      });
    } finally {
      timing.refineMs = Date.now() - refineStartedAt;
    }
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
      `refine=${timing.refineMs}ms`,
      `model=${timing.model}`,
      `names=${timing.names}`,
      `searchNetwork=${lookupStats.networkLookups || 0}`,
      `searchRequestCache=${lookupStats.requestCacheHits || 0}`,
      `searchSharedCache=${lookupStats.sharedCacheHits || 0}`,
      `searchBudgetExhausted=${lookupStats.budgetExhaustions || 0}`,
    ].join(' '));
  }
}
