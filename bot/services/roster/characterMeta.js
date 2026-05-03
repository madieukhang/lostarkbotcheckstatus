import config from '../../config.js';
import { findBibleNode } from '../../utils/bibleData.js';
import {
  configureMetaCache,
  getCachedMeta,
  setCachedMeta,
} from '../../utils/metaCache.js';
import { buildBibleFetchOptions, fetchWithFallback } from './bibleFetch.js';
import {
  parseCharacterMetaFromHtml,
  shapeCharacterMetaFromHeader,
} from './parsers.js';

configureMetaCache({
  ttlMs: config.metaCacheTtlMs,
  maxSize: config.metaCacheMaxSize,
});

const inFlightMetaFetches = new Map();

function normalizeMetaFetchKey(name) {
  return String(name || '').trim().toLowerCase();
}

function buildMetaInflightKey(name, options = {}) {
  return JSON.stringify({
    name: normalizeMetaFetchKey(name),
    allowScraperApi: options.allowScraperApi !== false,
    preferScraperApi: options.preferScraperApi === true,
    fallbackOnRateLimit: options.fallbackOnRateLimit === true,
    retryOnRateLimit: options.retryOnRateLimit !== false,
    timeoutMs: options.timeoutMs || 0,
  });
}

function cacheMetaResult(name, meta) {
  if (meta) setCachedMeta(name, meta);
  return meta;
}

async function fetchCharacterMetaUncached(name, options = {}) {
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}`;
    const fetchOptions = buildBibleFetchOptions(options);
    let res = await fetchWithFallback(jsonUrl, fetchOptions);

    if (res.status === 429 && options.retryOnRateLimit !== false) {
      console.warn(`[alt-detect] 429 rate-limited on ${name}, waiting 5s to retry...`);
      await new Promise((r) => setTimeout(r, 5000));
      res = await fetchWithFallback(jsonUrl, fetchOptions);
    }

    if (res.ok) {
      try {
        const parsed = await res.json();
        const payload = findBibleNode(parsed, 'header');
        const shaped = shapeCharacterMetaFromHeader(payload?.header);
        if (shaped) return shaped;
        console.warn(
          `[alt-detect] __data.json for ${name} did not contain expected header shape; falling back to HTML.`
        );
      } catch (jsonErr) {
        console.warn(
          `[alt-detect] __data.json parse failed for ${name}: ${jsonErr.message}; falling back to HTML.`
        );
      }
    }

    const htmlRes = await fetchWithFallback(htmlUrl, fetchOptions);
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();
    return parseCharacterMetaFromHtml(html);
  } catch (err) {
    console.warn(`[alt-detect] Failed to fetch meta for ${name}:`, err.message);
    return null;
  }
}

export async function fetchCharacterMeta(name, options = {}) {
  const useCache = options.useCache !== false;

  if (!useCache) {
    return fetchCharacterMetaUncached(name, options);
  }

  const cached = getCachedMeta(name);
  if (cached !== undefined) return cached;

  const inFlightKey = buildMetaInflightKey(name, options);
  const inFlight = inFlightMetaFetches.get(inFlightKey);
  if (inFlight) return inFlight;

  const fetchPromise = fetchCharacterMetaUncached(name, options)
    .then((meta) => cacheMetaResult(name, meta))
    .finally(() => {
      inFlightMetaFetches.delete(inFlightKey);
    });

  inFlightMetaFetches.set(inFlightKey, fetchPromise);
  return fetchPromise;
}
