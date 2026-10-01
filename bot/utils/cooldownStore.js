/**
 * Cooldown deadlines with automatic cleanup and one timer per store.
 */

/**
 * @param {number} ttlMs Cooldown duration in milliseconds.
 * @param {object} [options] Clock used to calculate deadlines.
 * @param {() => number} [options.now] Monotonic clock in milliseconds.
 * @returns {{remainingMs: Function, mark: Function, clear: Function, size: number}} Cooldown operations.
 */
export function createCooldownStore(ttlMs, { now = () => performance.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('createCooldownStore requires a positive ttlMs');
  }
  const deadlines = new Map();
  let expiryTimer = null;

  function scheduleExpiry(delayMs) {
    expiryTimer = setTimeout(sweep, delayMs);
    expiryTimer.unref?.();
  }

  function sweep() {
    expiryTimer = null;
    const currentTime = now();
    for (const [key, deadline] of deadlines) {
      if (deadline > currentTime) {
        scheduleExpiry(Math.max(1, deadline - currentTime));
        break;
      }
      deadlines.delete(key);
    }
  }

  return {
    remainingMs(key) {
      const remaining = (deadlines.get(key) ?? 0) - now();
      if (remaining > 0) return remaining;
      deadlines.delete(key);
      return 0;
    },
    mark(key) {
      // Fixed TTLs and a monotonic clock keep expiry order aligned with Map
      // insertion order, so cleanup only visits keys due to expire.
      deadlines.delete(key);
      deadlines.set(key, now() + ttlMs);
      if (!expiryTimer) scheduleExpiry(ttlMs);
    },
    clear() {
      clearTimeout(expiryTimer);
      expiryTimer = null;
      deadlines.clear();
    },
    get size() {
      return deadlines.size;
    },
  };
}
