/**
 * Process-local LRU cache with lazy TTL expiration and bounded writes.
 *
 * The cache owns the repeated miss/expiry/touch/eviction flow. Callers keep
 * responsibility for deciding which values are safe to cache.
 * @param {object} options Cache configuration.
 * @param {number | (() => number)} options.ttlMs Entry lifetime in milliseconds.
 * @param {number | (() => number)} options.maxSize Maximum number of entries.
 * @param {Function} [options.normalizeKey] Canonicalize lookup and write keys.
 * @param {Function} [options.cloneValue] Copy values on reads and writes.
 * @param {() => number} [options.now] Clock used to calculate expiry.
 * @returns {{clear: Function, get: Function, set: Function}} Cache operations.
 */
export function createLruTtlCache({
  ttlMs,
  maxSize,
  normalizeKey = (key) => key,
  cloneValue = (value) => value,
  now = Date.now,
} = {}) {
  for (const [label, value] of [
    ['normalizeKey', normalizeKey],
    ['cloneValue', cloneValue],
    ['now', now],
  ]) {
    if (typeof value !== 'function') {
      throw new TypeError(`createLruTtlCache requires ${label} to be a function`);
    }
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

    const limit = resolvePositiveSetting(maxSize, 'maxSize');

    // Remove the old value first so refreshing a key needs no extra slot.
    // Dynamic limits can shrink by more than one entry between writes.
    entries.delete(key);
    while (entries.size >= limit) {
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
