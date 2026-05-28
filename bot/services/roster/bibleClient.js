/**
 * services/roster/bibleClient.js
 * Transport selector for bible fetches. BIBLE_WORKER_ENABLED env +
 * per-call `viaWorker: true` flag together gate the residential-IP
 * sidecar transport. Narrow gate by design: heavy fan-out commands
 * (/la-list enrich, /la-roster deep, hidden roster fallback) need the
 * worker to bypass CF; latency-sensitive surfaces (search autocomplete,
 * one-off /la-list add) stay direct so UX doesn't collapse.
 */

import { fetchWithFallback } from './bibleFetch.js';
import { workerBibleClient } from './workerBibleClient.js';

function parseBoolEnv(raw) {
  if (!raw || raw.trim() === '') return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase());
}

const workerEnabled = parseBoolEnv(process.env.BIBLE_WORKER_ENABLED);

export const bibleClient = {
  workerEnabled,
  async fetch(url, options = {}) {
    if (workerEnabled && options.viaWorker === true) {
      return workerBibleClient.fetch(url, options);
    }
    return fetchWithFallback(url, options);
  },
};
