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

// Bot-side read. Returns { online, ageMs, lastSeenAt, startedAt, reason }.
// `online` is true when the heartbeat is fresher than maxStaleMs.
// Default 30s = 2x the worker interval so a single missed tick is OK,
// two consecutive misses flips to offline.
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
