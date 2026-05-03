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
const RETRYABLE_META_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_META_RETRY_DELAY_MS = 5000;
const MAX_META_RETRY_DELAY_MS = 15 * 1000;

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
    rateLimitRetryDelayMs: options.rateLimitRetryDelayMs || 0,
  });
}

function cacheMetaResult(name, meta) {
  if (meta) setCachedMeta(name, meta);
  return meta;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res, fallbackMs) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return fallbackMs;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_META_RETRY_DELAY_MS);
  }

  const retryAt = Date.parse(raw);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - Date.now()), MAX_META_RETRY_DELAY_MS);
  }

  return fallbackMs;
}

function shouldRetryMetaStatus(status, options) {
  if (options.retryOnRateLimit === false) return false;
  return RETRYABLE_META_STATUSES.has(status);
}

async function fetchMetaResponse(url, name, phase, options = {}) {
  const maxAttempts = options.retryOnRateLimit === false ? 1 : 2;
  const fallbackDelayMs = options.rateLimitRetryDelayMs ?? DEFAULT_META_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Build fetch options per attempt. Reusing AbortSignal.timeout()
      // across a 5s retry sleep leaves the retry with a half-expired
      // signal, which turns recoverable bible 429/503s into false nulls.
      const res = await fetchWithFallback(url, buildBibleFetchOptions(options));
      if (!shouldRetryMetaStatus(res.status, options) || attempt === maxAttempts) {
        return res;
      }

      const delayMs = parseRetryAfterMs(res, fallbackDelayMs);
      options.onRetryableStatus?.({ status: res.status, phase, name, attempt, delayMs });
      if (!options.suppressRetryWarnings) {
        console.warn(
          `[alt-detect] HTTP ${res.status} on ${phase} meta for ${name}, waiting ${delayMs}ms to retry...`
        );
      }
      await sleep(delayMs);
    } catch (err) {
      if (attempt === maxAttempts || options.retryOnRateLimit === false) {
        throw err;
      }

      console.warn(
        `[alt-detect] ${phase} meta fetch failed for ${name}: ${err.message}; ` +
        `waiting ${fallbackDelayMs}ms to retry...`
      );
      await sleep(fallbackDelayMs);
    }
  }

  return null;
}

async function fetchCharacterMetaUncached(name, options = {}) {
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}`;
    const res = await fetchMetaResponse(jsonUrl, name, '__data.json', options);

    if (res?.ok) {
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

    const htmlRes = await fetchMetaResponse(htmlUrl, name, 'HTML', options);
    if (!htmlRes?.ok) return null;
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
