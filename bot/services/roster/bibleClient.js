import { fetchWithFallback } from './bibleFetch.js';

// Single chokepoint for outbound bible requests. Phase 0 (this commit)
// is a pass-through to fetchWithFallback so behavior is unchanged. Phase
// 1 will plug in a worker-queue implementation here so the bot on Railway
// can offload bible fetches to a residential-IP sidecar without touching
// any of the upstream call sites that import bibleClient.
export const bibleClient = {
  async fetch(url, options = {}) {
    return fetchWithFallback(url, options);
  },
};
