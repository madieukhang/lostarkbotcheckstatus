/**
 * services/worker/scrape-worker.js
 * Worker-process side of the bot↔residential-IP scrape bridge. Polls
 * ScrapeJob for pending work, atomically claims the oldest, fetches
 * the target URL with bible-spoofed headers, and writes the response
 * back to Mongo for the bot to pick up. Stale in-progress jobs (lease
 * expired) are re-claimable so a crashed worker doesn't leave jobs
 * stuck. Lease window controlled by WORKER_JOB_LEASE_MS env (default
 * 2 min).
 */

import ScrapeJob from '../../models/ScrapeJob.js';
import { FETCH_HEADERS } from '../roster/bibleHeaders.js';

const FETCH_DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_JOB_LEASE_MS = (() => {
  const raw = parseInt(process.env.WORKER_JOB_LEASE_MS, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 1000;
})();

function abbreviateUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.length <= 100) return url;
  return `${url.slice(0, 80)}...${url.slice(-15)}`;
}

export function buildClaimNextJobFilter({
  now = Date.now,
  staleAfterMs = DEFAULT_JOB_LEASE_MS,
} = {}) {
  const staleStartedBefore = new Date(now() - staleAfterMs);
  return {
    $or: [
      { status: 'pending' },
      { status: 'in_progress', startedAt: { $lt: staleStartedBefore } },
    ],
  };
}

/**
 * Atomically claim the oldest pending (or stale-in-progress) job and
 * flip it to in_progress. Returns the updated document or null when no
 * work is available. Exposed for tests so they can drive a single
 * iteration without spawning a worker process.
 * @param {object} [options] - see buildClaimNextJobFilter
 * @returns {Promise<object|null>} claimed ScrapeJob doc or null
 */
export async function claimNextJob(options = {}) {
  return ScrapeJob.findOneAndUpdate(
    buildClaimNextJobFilter(options),
    {
      $set: { status: 'in_progress', startedAt: new Date(options.now?.() ?? Date.now()) },
      $unset: { completedAt: '', error: '', result: '' },
    },
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

/**
 * One worker iteration · claim oldest pending, process it, or report
 * idle when no work is available. The long-running worker process
 * loops over this with a sleep on idle. Tests call directly to drive
 * a deterministic single step.
 * @param {object} [opts]
 * @param {object} [opts.logger=console]
 * @returns {Promise<{state: "idle"|"done"|"failed", jobId?: string}>}
 */
export async function claimAndProcessOne({ logger = console } = {}) {
  const job = await claimNextJob();
  if (!job) return { state: 'idle' };
  const outcome = await executeJob(job, { logger });
  return { state: outcome.state, jobId: job._id, ...outcome };
}
