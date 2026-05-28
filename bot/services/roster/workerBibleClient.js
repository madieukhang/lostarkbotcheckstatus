/**
 * services/roster/workerBibleClient.js
 * Bridge from bot to the residential-IP scrape worker. Pushes jobs into
 * the ScrapeJob collection, polls until a worker fills in the response,
 * and re-hydrates a Fetch-Response-like object so callers using
 * bibleClient.fetch don't need to know the difference. Backpressure
 * gate (WORKER_QUEUE_BACKPRESSURE_THRESHOLD env, default 100) rejects
 * new inserts when the queue piles up · prevents callers from eating
 * 30s timeouts when the worker is offline.
 */

import ScrapeJobDefault from '../../models/ScrapeJob.js';
import { getWorkerHealth as getDefaultWorkerHealth } from '../worker/heartbeat.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;
// Backpressure threshold: if pending queue grows beyond this, reject
// new inserts with an explicit overload error. Tunable via env so prod
// can raise/lower without redeploy. 100 is a guess; revisit after real
// /la-list enrich runs surface actual queue depth distributions.
const DEFAULT_BACKPRESSURE_THRESHOLD = (() => {
  const raw = parseInt(process.env.WORKER_QUEUE_BACKPRESSURE_THRESHOLD, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
})();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Convert a Mongoose-stored Map of header name -> value into a plain
// object that the Response constructor accepts.
function headersFromStored(stored) {
  if (!stored) return {};
  if (stored instanceof Map) return Object.fromEntries(stored);
  return stored;
}

// Strip anything the worker cannot use or that won't survive the
// MongoDB round trip. Worker re-creates AbortSignal from timeoutMs.
function sanitizeOptions(options = {}) {
  const out = {};
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    out.timeoutMs = options.timeoutMs;
  }
  return out;
}

/**
 * Build a worker-routed bible client. Factory takes injected deps so
 * tests can pass a fake ScrapeJob model + shorter polling cadence.
 * Production singleton below the factory uses the real Mongoose model
 * and live cadence.
 * @param {object} [deps]
 * @param {object} [deps.ScrapeJob] - Mongoose model · defaults to real
 * @param {Function|null} [deps.getWorkerHealth] - heartbeat probe
 * @param {number} [deps.pollIntervalMs=500] - response-poll cadence
 * @param {number} [deps.defaultTimeoutMs=30000] - per-job ceiling
 * @param {number} [deps.backpressureThreshold] - max pending queue
 * @param {Function} [deps.now=Date.now]
 * @returns {{fetch: Function}} worker-routed fetch shim
 */
export function createWorkerBibleClient({
  ScrapeJob = ScrapeJobDefault,
  getWorkerHealth = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  backpressureThreshold = DEFAULT_BACKPRESSURE_THRESHOLD,
  now = () => Date.now(),
} = {}) {
  return {
    async fetch(url, options = {}) {
      const sanitized = sanitizeOptions(options);

      if (getWorkerHealth) {
        const health = await getWorkerHealth();
        if (!health.online) {
          const age = Number.isFinite(health.ageMs)
            ? `; last heartbeat ${Math.round(health.ageMs / 1000)}s ago`
            : '';
          throw new Error(
            `Stronghold lookup service is offline (${health.reason || 'unknown'}${age}). ` +
            'The bot owner\'s residential-IP worker is not running. Try again in a few minutes ' +
            'or ping the bot owner to start their local worker.'
          );
        }
      }

      // Backpressure: count pending jobs before insert. If the worker
      // is offline / overwhelmed and the queue grows past threshold,
      // reject immediately so the bot surfaces overload to users
      // rather than every caller eating a 30s timeout.
      const pendingCount = await ScrapeJob.countDocuments({ status: 'pending' });
      if (pendingCount >= backpressureThreshold) {
        throw new Error(
          `Scraping service overloaded: ${pendingCount} pending jobs ` +
          `(>= ${backpressureThreshold} threshold). Worker may be offline ` +
          `or behind. Try again in a minute.`
        );
      }

      const job = await ScrapeJob.create({
        url,
        options: sanitized,
        status: 'pending',
      });

      // Bot-side timeout is the caller's hint plus a small buffer for
      // the round trip through Mongo. Default 30s if caller didn't pin
      // a timeoutMs, which matches fetchWithFallback's typical ceiling.
      const timeoutMs = sanitized.timeoutMs
        ? sanitized.timeoutMs + 5_000
        : defaultTimeoutMs;
      const deadline = now() + timeoutMs;

      while (now() < deadline) {
        const fresh = await ScrapeJob.findById(job._id).lean();
        if (!fresh) {
          throw new Error(
            `Worker job ${job._id} disappeared (TTL expired or manually deleted).`
          );
        }
        if (fresh.status === 'done') {
          const headers = headersFromStored(fresh.result?.headers);
          // Status 204/205/304 disallow a non-null body; coerce empty
          // body strings to null so the Response constructor accepts
          // them on every status code worker may have written.
          const body = fresh.result?.body ? fresh.result.body : null;
          return new Response(body, {
            status: fresh.result?.status ?? 0,
            headers,
          });
        }
        if (fresh.status === 'failed') {
          throw new Error(`Worker fetch failed: ${fresh.error || 'unknown error'}`);
        }
        await sleep(pollIntervalMs);
      }

      throw new Error(
        `Worker fetch timed out after ${timeoutMs}ms (job ${job._id} still ${(await ScrapeJob.findById(job._id).lean())?.status || 'missing'}).`
      );
    },
  };
}

export const workerBibleClient = createWorkerBibleClient({
  getWorkerHealth: getDefaultWorkerHealth,
});
