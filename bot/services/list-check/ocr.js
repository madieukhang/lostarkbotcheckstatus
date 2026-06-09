import config from '../../config.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { fetchNameSuggestions } from '../roster/search.js';
import { hasAnyDiacritic, stripDiacritics } from './nameRecovery.js';

const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;

/** Known Lost Ark server/world names to filter from OCR results */
const SERVER_NAMES = new Set([
  'azena', 'avesta', 'galatur', 'karta', 'ladon', 'kharmine',
  'una', 'regulus', 'sasha', 'vykas', 'elgacia', 'thaemine',
  'brelshaza', 'kazeros', 'arcturus', 'enviska', 'valtan', 'mari',
  'akkan', 'vairgrys', 'bergstrom', 'danube', 'mokoko',
]);

const ocrCache = new Map();

function getCachedOcrNames(cacheKey) {
  if (!cacheKey) return undefined;
  const entry = ocrCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    ocrCache.delete(cacheKey);
    return undefined;
  }
  ocrCache.delete(cacheKey);
  ocrCache.set(cacheKey, entry);
  return [...entry.names];
}

function setCachedOcrNames(cacheKey, names) {
  if (!cacheKey || !Array.isArray(names)) return;
  if (ocrCache.size >= config.ocrCacheMaxSize) {
    const firstKey = ocrCache.keys().next().value;
    ocrCache.delete(firstKey);
  }
  ocrCache.set(cacheKey, {
    names: [...names],
    expiresAt: Date.now() + config.ocrCacheTtlMs,
  });
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

function filterAndDeduplicateNames(parsed) {
  const names = parsed
    .map((item) => (typeof item === 'string' ? normalizeCharacterName(item) : ''))
    .filter((name) => name && !SERVER_NAMES.has(name.toLowerCase()));

  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return unique;
}

async function findAmbiguousOcrChoices(names) {
  const choices = [];

  for (const name of names) {
    // This refinement is only for the dangerous case where Gemini
    // dropped a visible mark entirely (e.g. Crüelfighter -> Cruelfighter)
    // and Bible also has a real unmarked character. If the OCR already
    // contains a mark, the normal canonical matcher can rank it safely.
    if (hasAnyDiacritic(name)) continue;

    let suggestions = null;
    try {
      suggestions = await fetchNameSuggestions(name, { timeoutMs: 5000 });
    } catch (err) {
      console.warn(`[listcheck] OCR refine search skipped for ${name}: ${err.message}`);
      continue;
    }
    if (!Array.isArray(suggestions) || suggestions.length === 0) continue;

    const lower = name.toLowerCase();
    const exact = suggestions.find((s) => String(s.name).toLowerCase() === lower);
    if (!exact) continue;

    const base = stripDiacritics(name);
    const markedSiblings = suggestions
      .filter((s) => {
        const candidate = String(s.name || '');
        return candidate.toLowerCase() !== lower
          && stripDiacritics(candidate) === base
          && hasAnyDiacritic(candidate);
      })
      .map((s) => String(s.name));

    if (markedSiblings.length === 0) continue;
    choices.push({
      original: name,
      candidates: [String(exact.name), ...markedSiblings],
    });
  }

  return choices;
}

async function requestGeminiObject(prompt, imageBase64, mimeType) {
  const requestBody = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: { temperature: 0, topP: 0.1, maxOutputTokens: 512 },
  };

  const models = config.geminiModels.length > 0
    ? config.geminiModels
    : ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'];

  const failures = [];
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    let aiRes;
    try {
      aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      failures.push(`${model}: ${err.name || err.message}`);
      continue;
    }

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);
      if (i < models.length - 1 && shouldFailoverGeminiModel(aiRes.status, errBody)) continue;
      return null;
    }

    const payload = await aiRes.json();
    const text = (payload?.candidates?.[0]?.content?.parts || [])
      .filter((part) => !part.thought)
      .map((part) => part?.text ?? '')
      .join('')
      .trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      failures.push(`${model}: non-JSON object`);
      continue;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      failures.push(`${model}: invalid JSON object`);
    }
  }

  console.warn(`[listcheck] OCR ambiguity refinement failed: ${failures.join(' | ')}`);
  return null;
}

async function refineAmbiguousOcrNames(names, { imageBase64, mimeType } = {}) {
  const choices = await findAmbiguousOcrChoices(names);
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
 * @returns {Promise<string[]>} Array of normalized character names
 */
export async function extractNamesFromImage(image, options = {}) {
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
    console.log(`[listcheck] OCR cache hit for attachment ${image.id || cacheKey.slice(0, 32)}`);
    return cachedNames;
  }

  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  if (!imageRes.ok) {
    throw new Error(`Failed to download attachment (HTTP ${imageRes.status})`);
  }

  const contentLength = imageRes.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_OCR_IMAGE_BYTES) {
    throw new Error('Image file too large (max 20MB).');
  }

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  if (imageBuffer.byteLength > MAX_OCR_IMAGE_BYTES) {
    throw new Error('Image file too large (max 20MB).');
  }
  const imageBase64 = imageBuffer.toString('base64');

  const requestBody = {
    contents: [{ parts: [{ text: GEMINI_PROMPT }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: { temperature: 0, topP: 0.1, maxOutputTokens: 512 },
  };

  const models = config.geminiModels.length > 0
    ? config.geminiModels
    : ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'];
  const failures = [];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    let aiRes;
    try {
      aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });
    } catch (fetchErr) {
      failures.push(`${model}: ${fetchErr.name || fetchErr.message}`);
      if (i < models.length - 1) {
        console.warn(`[listcheck] Gemini timeout/network error on ${model}, trying fallback model.`);
        continue;
      }
      throw new Error(`Gemini request failed on ${model}: ${fetchErr.message}`);
    }

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);

      const canFallback = i < models.length - 1;
      if (canFallback && shouldFailoverGeminiModel(aiRes.status, errBody)) {
        console.warn(`[listcheck] Gemini quota/rate hit on ${model}, trying fallback model.`);
        continue;
      }

      throw new Error(`Gemini request failed on ${model} (HTTP ${aiRes.status}) ${errBody}`.trim());
    }

    const payload = await aiRes.json();
    const candidate = payload?.candidates?.[0];
    const finishReason = candidate?.finishReason;

    // Filter out thinking parts (thought: true) · only keep actual response text
    const parts = candidate?.content?.parts || [];
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part?.text ?? '')
      .join('')
      .trim();

    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[listcheck] Gemini (${model}) finishReason: ${finishReason}, text: ${text.slice(0, 100)}`);
    }

    if (!text) return [];

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // If this model returned non-JSON, try next model instead of throwing immediately
      const canFallback = i < models.length - 1;
      console.warn(`[listcheck] Gemini (${model}) returned non-JSON text: ${text.slice(0, 200)}`);
      if (canFallback) {
        failures.push(`${model}: non-JSON response`);
        continue;
      }
      throw new Error('Gemini did not return a JSON array.');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.warn(`[listcheck] Gemini (${model}) JSON parse failed: ${jsonMatch[0].slice(0, 200)}`);
      throw new Error('Gemini returned invalid JSON.');
    }
    if (!Array.isArray(parsed)) throw new Error('Gemini output is not an array.');

    let names = filterAndDeduplicateNames(parsed);
    if (refineAmbiguousDiacritics) {
      names = await refineAmbiguousOcrNames(names, { imageBase64, mimeType });
    }
    setCachedOcrNames(cacheKey, names);
    return names;
  }

  throw new Error(`All Gemini models failed: ${failures.join(' | ')}`);
}
