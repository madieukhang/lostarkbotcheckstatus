export const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

export async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(items[index], index);
      }
    })
  );

  return results;
}

/**
 * Log a listener's rejection instead of letting it escape. EventEmitter
 * ignores the promise an async listener returns, and process-lifecycle exits
 * the bot on any unhandled rejection, such as a component collector's
 * deferReply failing with Discord's "Unknown interaction".
 * @param {string} label log tag
 * @param {(...args: unknown[]) => Promise<void>} listener
 * @returns {(...args: unknown[]) => Promise<void>} a listener that never rejects
 */
export function catchListenerErrors(label, listener) {
  return async (...args) => {
    try {
      await listener(...args);
    } catch (err) {
      console.warn(`[${label}] Listener failed:`, err?.message || err);
    }
  };
}

/**
 * Coalesce overlapping update requests into the fewest possible async runs.
 * A request arriving during a run schedules one follow-up against the latest
 * state instead of racing an older render into the message afterwards.
 */
export function createLatestOnlyQueue(run, { onError = null } = {}) {
  if (typeof run !== 'function') {
    throw new TypeError('createLatestOnlyQueue requires a run function');
  }

  let requestedVersion = 0;
  let completedVersion = 0;
  let drainPromise = null;
  const pendingLabels = new Set();

  const drain = async () => {
    while (completedVersion < requestedVersion) {
      const targetVersion = requestedVersion;
      const labels = [...pendingLabels];
      pendingLabels.clear();
      try {
        await run(labels);
      } catch (err) {
        if (typeof onError === 'function') {
          try {
            await onError(err, labels);
          } catch {
            // Error reporting must never wedge the render queue.
          }
        }
      }
      completedVersion = targetVersion;
    }
  };

  const ensureDrain = () => {
    if (drainPromise) return drainPromise;
    drainPromise = Promise.resolve()
      .then(drain)
      .finally(() => {
        drainPromise = null;
        if (completedVersion < requestedVersion) ensureDrain();
      });
    return drainPromise;
  };

  const request = (label = 'update') => {
    requestedVersion += 1;
    if (label) pendingLabels.add(String(label));
    return ensureDrain();
  };

  const flush = async () => {
    while (drainPromise || completedVersion < requestedVersion) {
      await (drainPromise || ensureDrain());
    }
  };

  return { request, flush };
}
