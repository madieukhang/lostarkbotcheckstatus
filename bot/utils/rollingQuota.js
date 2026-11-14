/**
 * utils/rollingQuota.js
 * Per-key allowance over a sliding window: at most `limit` units in any
 * `windowMs`, each unit freed when it leaves the window. Process-local.
 */

/**
 * @param {object} options
 * @param {number} options.limit - units allowed per window
 * @param {number} options.windowMs - window length in milliseconds
 * @param {() => number} [options.now] - clock in milliseconds
 * @returns {{take: (key: string, count?: number) => boolean, clear: () => void}}
 *   `take` records `count` units and returns true, or records nothing and
 *   returns false when they do not fit
 */
export function createRollingQuota({ limit, windowMs, now = () => Date.now() }) {
  const usage = new Map();

  function liveStamps(key, currentTime) {
    const stamps = (usage.get(key) || []).filter((stamp) => currentTime - stamp < windowMs);
    if (stamps.length === 0) usage.delete(key);
    else usage.set(key, stamps);
    return stamps;
  }

  return {
    take(key, count = 1) {
      if (count <= 0) return true;
      const currentTime = now();
      const stamps = liveStamps(key, currentTime);
      if (stamps.length + count > limit) return false;
      usage.set(key, [...stamps, ...Array(count).fill(currentTime)]);
      return true;
    },
    clear() {
      usage.clear();
    },
  };
}
