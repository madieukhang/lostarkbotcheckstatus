/**
 * services/worker/heartbeat.js
 * Mongo-backed liveness signal for the residential-IP scrape worker.
 * Worker process ticks `lastSeenAt` every 15s · bot side reads with a
 * 30s stale threshold (2× interval so one missed tick is OK, two
 * consecutive flips to offline). Used by workerBibleClient as the
 * gate that decides whether to push a job vs reject with a clear
 * "worker offline" error.
 */

import WorkerHeartbeatDefault from '../../models/WorkerHeartbeat.js';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_WORKER_ID = process.env.WORKER_ID || 'default';

// Upsert pattern: $set bumps lastSeenAt every tick; $setOnInsert pins
// the startedAt to the moment the worker process came up so bot side
// can show "worker up since X" without relying on the worker preserving
// state across crashes.
export async function writeHeartbeat({
  WorkerHeartbeat = WorkerHeartbeatDefault,
  workerId = DEFAULT_WORKER_ID,
  startedAt = new Date(),
  pid = process.pid,
} = {}) {
  return WorkerHeartbeat.updateOne(
    { workerId },
    {
      $set: { lastSeenAt: new Date(), pid },
      $setOnInsert: { startedAt, workerId },
    },
    { upsert: true },
  );
}

/**
 * Start the heartbeat write loop on the worker side. Writes once
 * immediately so consumers see a fresh signal as soon as the worker
 * is up, then ticks every `intervalMs`. Returned handle is `.unref()`-ed
 * so it never keeps the process alive on its own.
 * @param {object} [opts]
 * @param {object} [opts.WorkerHeartbeat] - Mongoose model (test injection)
 * @param {string} [opts.workerId]
 * @param {number} [opts.intervalMs=15000]
 * @param {object} [opts.logger=console]
 * @returns {*} setInterval handle (pass to stopHeartbeat to cancel)
 */
export function startHeartbeat({
  WorkerHeartbeat = WorkerHeartbeatDefault,
  workerId = DEFAULT_WORKER_ID,
  intervalMs = DEFAULT_INTERVAL_MS,
  logger = console,
} = {}) {
  const startedAt = new Date();
  const tick = () => {
    writeHeartbeat({ WorkerHeartbeat, workerId, startedAt }).catch((err) => {
      logger.warn?.(`[heartbeat] write failed: ${err.message}`);
    });
  };

  // Write once immediately so consumers see a fresh signal as soon as
  // the worker comes up, rather than waiting one full interval.
  tick();
  const handle = setInterval(tick, intervalMs);
  if (handle.unref) handle.unref();
  return handle;
}

export function stopHeartbeat(handle) {
  if (handle) clearInterval(handle);
}

/**
 * Bot-side liveness probe. `online` is true when the last heartbeat
 * is fresher than `maxStaleMs` (default 30s = 2× worker interval).
 * @param {object} [opts]
 * @param {object} [opts.WorkerHeartbeat]
 * @param {string} [opts.workerId]
 * @param {number} [opts.maxStaleMs=30000]
 * @returns {Promise<{online: boolean, reason: string, lastSeenAt: Date|null, ageMs: number|null, startedAt: Date|null}>}
 */
export async function getWorkerHealth({
  WorkerHeartbeat = WorkerHeartbeatDefault,
  workerId = DEFAULT_WORKER_ID,
  maxStaleMs = DEFAULT_STALE_MS,
  now = Date.now,
} = {}) {
  const doc = await WorkerHeartbeat.findOne({ workerId }).lean();
  if (!doc) {
    return {
      online: false,
      reason: 'no-heartbeat-record',
      lastSeenAt: null,
      ageMs: null,
      startedAt: null,
    };
  }
  const ageMs = now() - new Date(doc.lastSeenAt).getTime();
  return {
    online: ageMs <= maxStaleMs,
    reason: ageMs <= maxStaleMs ? 'fresh' : 'stale-heartbeat',
    lastSeenAt: doc.lastSeenAt,
    ageMs,
    startedAt: doc.startedAt,
  };
}
