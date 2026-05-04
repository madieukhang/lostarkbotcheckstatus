import { fetchWithFallback } from './bibleFetch.js';
import { workerBibleClient } from './workerBibleClient.js';

// Worker mode is a kill-switch for the residential-IP sidecar transport.
// When BIBLE_WORKER_ENABLED is on, opt-in callers (those that pass
// `viaWorker: true` in options) get routed to workerBibleClient. All
// other callers stay on direct fetchWithFallback. This narrow gate is
// intentional: heavy fan-out commands (/la-list enrich, /la-roster
// deep, hidden roster fallback) need the residential IP to bypass CF;
// latency-sensitive commands like search autocomplete and one-off
// /la-list add must stay direct or the bot's UX collapses.
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
