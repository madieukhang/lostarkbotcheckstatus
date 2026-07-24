/**
 * services/roster/search.js
 * Wrappers around the lostark.bible name-search API. The API speaks a
 * compact reference-payload JSON (numeric indices into a `data` array)
 * so the decoding here is invariant-critical · break it and search
 * autocomplete and hidden-roster inference both return null.
 * Reminder: this API is NFC-only and prefix-based with single-edit
 * tolerance · see [[reference-bible-api]] for the full behaviour notes.
 */

import config from '../../config.js';
import { getClassName } from '../../models/Class.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildBibleFetchOptions } from './bibleFetch.js';
import { bibleClient } from './bibleClient.js';
import { parseItemLevelValue } from './parsers.js';

const sharedSuggestionCache = new Map();
const CACHE_MISS = Symbol('name-suggestion-cache-miss');

function ensureLookupStats(context) {
  if (!context || typeof context !== 'object') return null;
  if (!context.stats || typeof context.stats !== 'object') {
    context.stats = {};
  }
  for (const key of [
    'networkLookups',
    'requestCacheHits',
    'sharedCacheHits',
    'budgetExhaustions',
  ]) {
    if (!Number.isFinite(context.stats[key])) context.stats[key] = 0;
  }
  return context.stats;
}

/**
 * Create one lookup context for an end-to-end user request. OCR refinement
 * and list enrichment share the same cache and network-call budget.
 */
export function createNameSuggestionContext({
  cache = new Map(),
  maxNetworkLookups = Infinity,
} = {}) {
  const parsedLimit = Number(maxNetworkLookups);
  return {
    cache: cache instanceof Map ? cache : new Map(),
    maxNetworkLookups: Number.isFinite(parsedLimit)
      ? Math.max(0, Math.floor(parsedLimit))
      : Infinity,
    stats: {
      networkLookups: 0,
      requestCacheHits: 0,
      sharedCacheHits: 0,
      budgetExhaustions: 0,
    },
  };
}

function trimSharedSuggestionCache() {
  const maxSize = Math.max(1, config.nameSuggestionCacheMaxSize || 1000);
  while (sharedSuggestionCache.size >= maxSize) {
    const oldestKey = sharedSuggestionCache.keys().next().value;
    if (oldestKey === undefined) break;
    sharedSuggestionCache.delete(oldestKey);
  }
}

function getSharedSuggestion(cacheKey) {
  const entry = sharedSuggestionCache.get(cacheKey);
  if (!entry) return CACHE_MISS;
  if (!entry.promise && Date.now() >= entry.expiresAt) {
    sharedSuggestionCache.delete(cacheKey);
    return CACHE_MISS;
  }

  // Map insertion order doubles as a compact LRU list.
  sharedSuggestionCache.delete(cacheKey);
  sharedSuggestionCache.set(cacheKey, entry);
  return entry.promise || entry.value;
}

function setSharedSuggestionPending(cacheKey, promise) {
  sharedSuggestionCache.delete(cacheKey);
  trimSharedSuggestionCache();
  sharedSuggestionCache.set(cacheKey, { promise, value: null, expiresAt: Infinity });
}

function settleSharedSuggestion(cacheKey, promise, result) {
  const current = sharedSuggestionCache.get(cacheKey);
  if (!current || current.promise !== promise) return;
  if (!Array.isArray(result)) {
    sharedSuggestionCache.delete(cacheKey);
    return;
  }

  const ttlMs = result.length > 0
    ? config.nameSuggestionCacheTtlMs
    : config.nameSuggestionEmptyCacheTtlMs;
  sharedSuggestionCache.delete(cacheKey);
  sharedSuggestionCache.set(cacheKey, {
    promise: null,
    value: result,
    expiresAt: Date.now() + ttlMs,
  });
}

/** Test/maintenance hook; production eviction normally happens via TTL/LRU. */
export function clearNameSuggestionCache() {
  sharedSuggestionCache.clear();
}

function decodeSearchResponse(json) {
  if (json?.type !== 'result') {
    throw new Error(`Unsupported search response type: ${json?.type || 'missing'}`);
  }

  // lostark.bible moved the encoded reference table from `result` to
  // `data` and wrapped its root array behind a `{ _: <index> }` pointer.
  // Accept both envelopes so an upstream rollout does not turn every
  // valid name into a false "no matches" result.
  const encodedTable = json.data ?? json.result;
  const table = typeof encodedTable === 'string'
    ? JSON.parse(encodedTable)
    : encodedTable;

  if (!Array.isArray(table)) {
    throw new Error('Unsupported search response table');
  }

  let rowRefs = table[0];
  if (!Array.isArray(rowRefs)) {
    const rootIndex = rowRefs?._;
    if (!Number.isInteger(rootIndex) || !Array.isArray(table[rootIndex])) {
      throw new Error('Unsupported search response root');
    }
    rowRefs = table[rootIndex];
  }

  return rowRefs.map((pointer) => {
    const group = table[pointer];
    if (!Array.isArray(group) || group.length < 3) {
      throw new Error('Unsupported search response row');
    }

    const [nameIdx, classIdx, ilvlIdx] = group;
    const charName = table[nameIdx];
    if (!charName || typeof charName !== 'string') {
      throw new Error('Unsupported search response name');
    }

    return {
      name: charName,
      cls: table[classIdx] ?? '',
      itemLevel: table[ilvlIdx] ?? 0,
    };
  });
}

/**
 * Hit the bible name-search endpoint and decode the reference-payload
 * JSON into a `[{name, cls, itemLevel}]` array. Returns null on
 * transport error (caller distinguishes that from "no results").
 * @param {string} name - prefix or near-match candidate
 * @param {object} [options] - forwarded to buildBibleFetchOptions
 * @param {Map} [options.suggestionCache] - request-local cache that also
 *   deduplicates concurrent lookups for the same normalized query
 * @param {object} [options.suggestionContext] - shared request cache, budget,
 *   and counters created by createNameSuggestionContext
 * @returns {Promise<Array<{name: string, cls: string, itemLevel: number|string}>|null>}
 */
export async function fetchNameSuggestions(name, options = {}) {
  const {
    suggestionCache,
    suggestionContext,
    ...fetchOptions
  } = options;
  const cacheKey = String(name || '').normalize('NFC').toLowerCase();
  const requestCache = suggestionContext?.cache instanceof Map
    ? suggestionContext.cache
    : suggestionCache;
  const canCache = requestCache instanceof Map && Boolean(cacheKey);
  const stats = ensureLookupStats(suggestionContext);

  if (canCache && requestCache.has(cacheKey)) {
    if (stats) stats.requestCacheHits += 1;
    return requestCache.get(cacheKey);
  }

  if (cacheKey) {
    const shared = getSharedSuggestion(cacheKey);
    if (shared !== CACHE_MISS) {
      if (stats) stats.sharedCacheHits += 1;
      const sharedRequest = Promise.resolve(shared);
      if (canCache) requestCache.set(cacheKey, sharedRequest);
      const result = await sharedRequest;
      if (canCache && result === null) requestCache.delete(cacheKey);
      return result;
    }
  }

  if (suggestionContext) {
    const maxNetworkLookups = Number.isFinite(suggestionContext.maxNetworkLookups)
      ? Math.max(0, suggestionContext.maxNetworkLookups)
      : Infinity;
    if (stats.networkLookups >= maxNetworkLookups) {
      stats.budgetExhaustions += 1;
      return null;
    }
    stats.networkLookups += 1;
  }

  const request = (async () => {
    try {
      const payload = Buffer.from(JSON.stringify([{ name: 1, region: 2 }, name, 'NA'])).toString('base64');
      const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
      const res = await bibleClient.fetch(targetUrl, buildBibleFetchOptions(fetchOptions));
      if (!res.ok) {
        console.warn(`[search] lostark.bible search API returned HTTP ${res.status} for "${name}"`);
        return null;
      }

      const json = await res.json();
      return decodeSearchResponse(json);
    } catch (err) {
      console.warn(`[search] fetchNameSuggestions error for "${name}":`, err.message);
      return null;
    }
  })();

  if (cacheKey) setSharedSuggestionPending(cacheKey, request);
  if (canCache) requestCache.set(cacheKey, request);

  try {
    const result = await request;
    if (cacheKey) settleSharedSuggestion(cacheKey, request, result);
    // Keep successful and empty lookups for this request. Transport or
    // contract failures remain retryable if the upstream recovers.
    if (canCache && result === null) requestCache.delete(cacheKey);
    return result;
  } catch (err) {
    if (cacheKey) settleSharedSuggestion(cacheKey, request, null);
    if (canCache) requestCache.delete(cacheKey);
    throw err;
  }
}

/**
 * Hidden-roster fallback · when a character's full roster page is
 * private but the name still appears in search results, the result can
 * provide the item level. Used by buildRosterCharacters'
 * hiddenRosterFallback path.
 * @param {string} name - exact character name (case-insensitive match)
 * @param {object} [options] - forwarded to fetchNameSuggestions
 * @returns {Promise<number|null>}
 */
export async function inferHiddenRosterItemLevel(name, options = {}) {
  const suggestions = await fetchNameSuggestions(name, options);
  const exact = suggestions?.find((s) => s.name?.toLowerCase() === name.toLowerCase());
  return exact ? parseItemLevelValue(exact.itemLevel) : null;
}

export function formatSuggestionLines(suggestions) {
  return suggestions
    .map((s) => `[${s.name}](${rosterUrl(s.name)}) · \`${Number(s.itemLevel).toFixed(2)}\` · ${getClassName(s.cls)}`)
    .join('\n');
}
