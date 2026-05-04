import ScrapeJobDefault from '../../models/ScrapeJob.js';

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

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

// Factory that takes injected dependencies so tests can pass a fake
// ScrapeJob model and shorter intervals. Production singleton below
// uses the real Mongoose model and live polling cadence.
export function createWorkerBibleClient({
  ScrapeJob = ScrapeJobDefault,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  return {
    async fetch(url, options = {}) {
      const sanitized = sanitizeOptions(options);
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

export const workerBibleClient = createWorkerBibleClient();
