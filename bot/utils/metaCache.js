/**
 * In-memory LRU+TTL cache for `fetchCharacterMeta` results.
 *
 * Why this exists:
 *   /la-roster deep alt-detect fetches every guild candidate's meta one
 *   by one to compare stronghold + rosterLevel. On large guilds this
 *   is hundreds of bible round-trips per scan, and repeated scans
 *   (the same user re-running /la-roster, or two users asking about the
 *   same guild) re-hit the same characters. A short-lived in-memory
 *   cache absorbs that repetition without changing data semantics:
 *   stronghold + rosterLevel are roster-account properties that
 *   change on the order of days, so a 30-minute TTL is well within
 *   their natural drift.
 *
 *   The /list enrich flow (Phase 3) will reuse the same cache so a
 *   user who runs /la-list enrich right after /la-roster deep gets near-
 *   instant resolution instead of paying the per-candidate fetch
 *   tax twice in a row.
 *
 * Design choices:
 *   - **Cache only non-null**: a `null` from fetchCharacterMeta means
 *     a transient 429, 5xx, or HTML parse failure. Caching nulls would
 *     pin a transient outage into the cache for the full TTL window
 *     and starve later scans of a chance to retry. Successful meta is
 *     stable enough to cache; failure is not.
 *   - **LRU on access + insert**: re-inserting on read keeps recently-
 *     used keys away from the eviction edge. Eviction picks the oldest
 *     key (Map iteration order is insertion order in V8).
 *   - **Lazy expiry on read**: no separate sweep, no setInterval. Each
 *     `get` checks the entry's `expiresAt` and removes if stale. Drop-
 *     simple and good enough for the observed scan cadence.
 *   - **In-memory only**: bot restart drops the cache, which is fine -
 *     the next /la-roster deep simply pays the cold-cache cost once and
 *     repopulates. Persisting to Mongo is a Phase 2.5+ concern that
 *     would need invalidation hooks; not justified by current load.
 */

let metaCacheTtlMs = 30 * 60 * 1000;
let metaCacheMaxSize = 5000;
const cache = new Map();

export function configureMetaCache({ ttlMs, maxSize } = {}) {
  if (typeof ttlMs === 'number' && ttlMs > 0) metaCacheTtlMs = ttlMs;
  if (typeof maxSize === 'number' && maxSize > 0) metaCacheMaxSize = maxSize;
}

export function getCachedMeta(name) {
  const key = normalize(name);
  if (!key) return undefined;
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  // LRU touch: re-insert so this key moves to "most recently used".
  cache.delete(key);
  cache.set(key, entry);
  return entry.meta;
}

export function setCachedMeta(name, meta) {
  const key = normalize(name);
  if (!key) return;
  // Evict the oldest entry when at capacity. Map iteration order in
  // V8 is insertion order, so the first key is the LRU candidate.
  if (cache.size >= metaCacheMaxSize) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { meta, expiresAt: Date.now() + metaCacheTtlMs });
}

export function clearMetaCache() {
  cache.clear();
}

export function getMetaCacheStats() {
  return { size: cache.size, ttlMs: metaCacheTtlMs, maxSize: metaCacheMaxSize };
}

function normalize(name) {
  return String(name || '').trim().toLowerCase();
}
