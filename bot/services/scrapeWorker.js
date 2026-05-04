import ScrapeJob from '../models/ScrapeJob.js';
import { FETCH_HEADERS } from './roster/bibleHeaders.js';

const FETCH_DEFAULT_TIMEOUT_MS = 15_000;

function abbreviateUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.length <= 100) return url;
  return `${url.slice(0, 80)}...${url.slice(-15)}`;
}

// Atomically grab the oldest pending job and flip it to in_progress.
// Returns the job document (with the updated state) or null when no
// pending work is available. Exposed for tests so they can drive a
// single iteration without spawning a worker process.
export async function claimNextJob() {
  return ScrapeJob.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'in_progress', startedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' },
  );
}

async function executeJob(job, { logger = console } = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number.isFinite(job.options?.timeoutMs) && job.options.timeoutMs > 0
    ? job.options.timeoutMs
    : FETCH_DEFAULT_TIMEOUT_MS;

  try {
    const res = await fetch(job.url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    const headers = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    await ScrapeJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'done',
          completedAt: new Date(),
          result: { status: res.status, headers, body },
        },
      },
    );
    logger.log?.(
      `[worker] done ${job._id} ${Date.now() - startedAt}ms ` +
      `HTTP ${res.status} ${body.length}B ${abbreviateUrl(job.url)}`,
    );
    return { state: 'done', status: res.status, bodyLength: body.length };
  } catch (err) {
    await ScrapeJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'failed',
          completedAt: new Date(),
          error: err.message || String(err),
        },
      },
    );
    logger.warn?.(
      `[worker] failed ${job._id} ${Date.now() - startedAt}ms ` +
      `${err.message} ${abbreviateUrl(job.url)}`,
    );
    return { state: 'failed', error: err.message || String(err) };
  }
}

// One worker iteration: claim oldest pending, process it, or report
// idle if no work was available. Tests call this directly. The
// long-running worker process loops over it with a sleep on idle.
export async function claimAndProcessOne({ logger = console } = {}) {
  const job = await claimNextJob();
  if (!job) return { state: 'idle' };
  const outcome = await executeJob(job, { logger });
  return { state: outcome.state, jobId: job._id, ...outcome };
}
