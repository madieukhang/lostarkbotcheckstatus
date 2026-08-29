/**
 * Process-local LRU cache with lazy TTL expiration.
 *
 * The cache owns the repeated miss/expiry/touch/eviction flow. Callers keep
 * responsibility for deciding which values are safe to cache.
 */
export function createLruTtlCache({
  ttlMs,
  maxSize,
  normalizeKey = (key) => key,
  cloneValue = (value) => value,
  now = Date.now,
} = {}) {
  if (typeof normalizeKey !== 'function') {
    throw new TypeError('createLruTtlCache requires normalizeKey to be a function');
  }
  if (typeof cloneValue !== 'function') {
    throw new TypeError('createLruTtlCache requires cloneValue to be a function');
  }
  if (typeof now !== 'function') {
    throw new TypeError('createLruTtlCache requires now to be a function');
  }

  const resolvePositiveSetting = (setting, label) => {
    const value = typeof setting === 'function' ? setting() : setting;
    if (!(Number(value) > 0)) {
      throw new TypeError(`createLruTtlCache requires a positive ${label}`);
    }
    return Number(value);
  };

  // Fail fast for static configuration while still allowing dynamic config
  // functions to be re-read on every write.
  resolvePositiveSetting(ttlMs, 'ttlMs');
  resolvePositiveSetting(maxSize, 'maxSize');

  const entries = new Map();

  function get(rawKey) {
    const key = normalizeKey(rawKey);
    if (!key) return undefined;

    const entry = entries.get(key);
    if (!entry) return undefined;
    if (now() > entry.expiresAt) {
      entries.delete(key);
      return undefined;
    }

    // Map insertion order is the LRU order. Reinsert a hit at the MRU edge.
    entries.delete(key);
    entries.set(key, entry);
    return cloneValue(entry.value);
  }

  function set(rawKey, value) {
    const key = normalizeKey(rawKey);
    if (!key) return false;

    // Updating an existing entry must not evict an unrelated key at capacity.
    const existed = entries.delete(key);
    const limit = resolvePositiveSetting(maxSize, 'maxSize');
    if (!existed && entries.size >= limit) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }

    entries.set(key, {
      value: cloneValue(value),
      expiresAt: now() + resolvePositiveSetting(ttlMs, 'ttlMs'),
    });
    return true;
  }

  function clear() {
    entries.clear();
  }

  return {
    clear,
    get,
    set,
  };
}
