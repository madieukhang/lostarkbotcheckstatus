import config from '../../config.js';

export const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * Smart fallback cache - remembers when direct fetch is blocked by Cloudflare.
 * Skips the wasted direct request for BLOCK_CACHE_MS after a 403/503.
 */
let directBlockedUntil = 0;
const BLOCK_CACHE_MS = 5 * 60 * 1000;

/**
 * Exhausted/invalid key tracking - skip dead keys for KEY_COOLDOWN_MS.
 * Status 401/403 (invalid key) or 429 (quota exhausted) marks key as dead.
 */
const deadKeysUntil = new Map();
const KEY_COOLDOWN_MS = 10 * 60 * 1000;

export function buildBibleFetchOptions(options = {}) {
  const fetchOptions = {
    allowScraperApi: options.allowScraperApi !== false,
    preferScraperApi: options.preferScraperApi === true,
    fallbackOnRateLimit: options.fallbackOnRateLimit === true,
  };
  if (options.timeoutMs) {
    fetchOptions.signal = AbortSignal.timeout(options.timeoutMs);
  }
  return fetchOptions;
}

async function tryScraperApi(url, key, keyIndex) {
  const proxyUrl = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(30000) });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const body = await res.text().catch(() => '');
      console.warn(`[scraperapi] Key #${keyIndex + 1} failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
      deadKeysUntil.set(key, Date.now() + KEY_COOLDOWN_MS);
      return { res, keyDead: true };
    }
    return { res, keyDead: false };
  } catch (err) {
    console.warn(`[scraperapi] Key #${keyIndex + 1} network error: ${err.message}`);
    return { res: null, keyDead: false, error: err };
  }
}

async function fetchViaScraperApi(url) {
  const keys = config.scraperApiKeys || [];
  if (keys.length === 0) return null;

  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const deadUntil = deadKeysUntil.get(key) || 0;
    if (Date.now() < deadUntil) {
      errors.push(`Key #${i + 1}: skipped (cooling down)`);
      continue;
    }

    const { res, keyDead, error } = await tryScraperApi(url, key, i);
    if (error) { errors.push(`Key #${i + 1}: ${error.message}`); continue; }
    if (keyDead) { errors.push(`Key #${i + 1}: HTTP ${res.status}`); continue; }
    if (res.ok) {
      console.log(`[scraperapi] Key #${i + 1} success`);
      return res;
    }
    return res;
  }

  console.error(`[scraperapi] All ${keys.length} key(s) failed: ${errors.join(' | ')}`);
  return null;
}

export async function fetchWithFallback(url, options = {}) {
  const {
    allowScraperApi = true,
    preferScraperApi = false,
    fallbackOnRateLimit = false,
    ...fetchOptions
  } = options;
  const hasKey = allowScraperApi && config.scraperApiKeys?.length > 0;

  if (preferScraperApi && hasKey) {
    const proxyRes = await fetchViaScraperApi(url);
    if (proxyRes) return proxyRes;
    console.warn(`[fetch] ScraperAPI preferred but unavailable, falling back to direct fetch: ${url}`);
  }

  if (Date.now() < directBlockedUntil && hasKey) {
    const res = await fetchViaScraperApi(url);
    if (res) return res;
    console.warn(`[fetch] All ScraperAPI keys dead, attempting direct fetch despite cache: ${url}`);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
      ...fetchOptions,
    });
  } catch (err) {
    console.warn(`[fetch] Direct fetch failed: ${err.message}`);
    if (hasKey) {
      const proxyRes = await fetchViaScraperApi(url);
      if (proxyRes) return proxyRes;
    }
    throw err;
  }

  if ((res.status === 403 || res.status === 503 || (res.status === 429 && fallbackOnRateLimit)) && hasKey) {
    if (res.status === 403 || res.status === 503) {
      directBlockedUntil = Date.now() + BLOCK_CACHE_MS;
    }
    console.warn(`[fetch] ${res.status} on direct fetch. Falling back to ScraperAPI: ${url}`);
    const proxyRes = await fetchViaScraperApi(url);
    if (proxyRes) return proxyRes;
    console.error(`[fetch] All ScraperAPI fallbacks failed for ${url}, returning original ${res.status}`);
  }

  return res;
}
