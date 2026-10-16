import config from '../../config.js';
import { findBibleNode } from '../../utils/bibleData.js';
import { normalizeNameKey } from '../../utils/names.js';
import {
  configureMetaCache,
  getCachedMeta,
  setCachedMeta,
} from '../../utils/cache/metaCache.js';
import { buildBibleFetchOptions } from './bibleFetch.js';
import { bibleClient } from './bibleClient.js';
import {
  parseCharacterMetaFromHtml,
  shapeCharacterMetaFromHeader,
} from './parsers.js';
import { sleep } from '../../utils/async.js';
import { parseRetryAfterMs } from '../../utils/parseRetryAfterMs.js';

configureMetaCache({
  ttlMs: config.metaCacheTtlMs,
  maxSize: config.metaCacheMaxSize,
});

const inFlightMetaFetches = new Map();
const RETRYABLE_META_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_META_RETRY_DELAY_MS = 5000;
const MAX_META_RETRY_DELAY_MS = 15 * 1000;

// In-flight sharing must preserve transport and retry policy. Otherwise a
// strict no-proxy caller could inherit a worker/ScraperAPI request (or vice versa).
function buildMetaInflightKey(name, options = {}) {
  return JSON.stringify({
    name: normalizeNameKey(name),
    allowScraperApi: options.allowScraperApi !== false,
    preferScraperApi: options.preferScraperApi === true,
    fallbackOnRateLimit: options.fallbackOnRateLimit === true,
    retryOnRateLimit: options.retryOnRateLimit !== false,
    viaWorker: options.viaWorker === true,
    timeoutMs: options.timeoutMs || 0,
    rateLimitRetryDelayMs: options.rateLimitRetryDelayMs || 0,
  });
}

// Callbacks whose calls a joining caller must still see after the shared
// request settles.
const REPLAYED_META_CALLBACKS = ['onMetaFetchResult', 'onRetryableStatus'];

// Wrap the owner's callbacks so every call is logged for joiners while the
// owner still receives it immediately.
function recordMetaCallbacks(options, calls) {
  const recorded = { ...options };
  for (const callback of REPLAYED_META_CALLBACKS) {
    recorded[callback] = (payload) => {
      calls.push([callback, payload]);
      options[callback]?.(payload);
    };
  }
  return recorded;
}

function cacheMetaResult(name, meta) {
  if (meta) setCachedMeta(name, meta);
  return meta;
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
      const res = await bibleClient.fetch(url, buildBibleFetchOptions(options));
      options.onMetaFetchResult?.({
        name,
        phase,
        status: res.status,
        ok: res.ok,
        attempt,
      });
      if (!shouldRetryMetaStatus(res.status, options) || attempt === maxAttempts) {
        return res;
      }

      const delayMs = parseRetryAfterMs(res.headers?.get?.('retry-after'), {
        fallbackMs: fallbackDelayMs,
        capMs: MAX_META_RETRY_DELAY_MS,
      });
      options.onRetryableStatus?.({ status: res.status, phase, name, attempt, delayMs });
      if (!options.suppressRetryWarnings) {
        console.warn(
          `[alt-detect] HTTP ${res.status} on ${phase} meta for ${name}, waiting ${delayMs}ms to retry...`
        );
      }
      await sleep(delayMs);
    } catch (err) {
      options.onMetaFetchResult?.({
        name,
        phase,
        error: err,
        attempt,
      });
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
}

async function fetchCharacterMetaUncached(name, options = {}) {
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}`;
    const res = await fetchMetaResponse(jsonUrl, name, '__data.json', options);

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

    const htmlRes = await fetchMetaResponse(htmlUrl, name, 'HTML', options);
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();
    return parseCharacterMetaFromHtml(html);
  } catch (err) {
    console.warn(`[alt-detect] Failed to fetch meta for ${name}:`, err.message);
    return null;
  }
}

/**
 * Fetch a character's profile meta, sharing one request among identical callers.
 * A caller that joins a running request gets the owner's per-attempt
 * `onMetaFetchResult` and `onRetryableStatus` calls replayed, in order, once
 * that request settles.
 *
 * @param {string} name - Character name
 * @param {object} [options] - Transport and retry policy forwarded to the Bible client
 * @param {boolean} [options.useCache=true] - Read and write the meta cache and share in-flight requests
 * @param {(result: object) => void} [options.onMetaFetchResult] - Called with each request attempt's status or error
 * @param {(retry: object) => void} [options.onRetryableStatus] - Called with each retryable status before the retry wait
 * @returns {Promise<object|null>} Profile meta, or null when the character is unknown or the read failed
 */
export async function fetchCharacterMeta(name, options = {}) {
  const useCache = options.useCache !== false;

  if (!useCache) {
    return fetchCharacterMetaUncached(name, options);
  }

  const cached = getCachedMeta(name);
  if (cached !== undefined) return cached;

  const inFlightKey = buildMetaInflightKey(name, options);
  const inFlight = inFlightMetaFetches.get(inFlightKey);
  if (inFlight) {
    const meta = await inFlight.promise;
    for (const [callback, payload] of inFlight.calls) options[callback]?.(payload);
    return meta;
  }

  const calls = [];
  const promise = fetchCharacterMetaUncached(name, recordMetaCallbacks(options, calls))
    .then((meta) => cacheMetaResult(name, meta))
    .finally(() => {
      inFlightMetaFetches.delete(inFlightKey);
    });

  inFlightMetaFetches.set(inFlightKey, { promise, calls });
  return promise;
}
