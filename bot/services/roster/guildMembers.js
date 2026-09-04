import config from '../../config.js';
import { findBibleNode } from '../../utils/bibleData.js';
import { createLruTtlCache } from '../../utils/cache/lruTtlCache.js';
import { normalizeNameKey } from '../../utils/names.js';
import { buildBibleFetchOptions } from './bibleFetch.js';
import { bibleClient } from './bibleClient.js';
import { parseGuildMembersFromHtml } from './parsers.js';

const guildMembersCache = createLruTtlCache({
  ttlMs: () => config.guildMembersCacheTtlMs,
  maxSize: () => config.guildMembersCacheMaxSize,
  normalizeKey: normalizeNameKey,
});
const inFlightGuildMemberFetches = new Map();

// Completed guild data is transport-agnostic and may share the normal cache.
// Pending work is policy-sensitive so opted-out callers never inherit a proxy.
function buildGuildMembersInflightKey(cacheKey, options = {}) {
  return JSON.stringify({
    cacheKey: normalizeNameKey(cacheKey),
    allowScraperApi: options.allowScraperApi !== false,
    preferScraperApi: options.preferScraperApi === true,
    fallbackOnRateLimit: options.fallbackOnRateLimit === true,
    viaWorker: options.viaWorker === true,
    timeoutMs: options.timeoutMs || 0,
  });
}

function getCachedGuildMembers(cacheKey) {
  return guildMembersCache.get(cacheKey);
}

function setCachedGuildMembers(cacheKey, members) {
  if (!Array.isArray(members) || members.length === 0) return;
  guildMembersCache.set(cacheKey, members);
}

export function clearGuildMembersCache() {
  guildMembersCache.clear();
  inFlightGuildMemberFetches.clear();
}

async function fetchGuildMembersUncached(name, options = {}) {
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild`;
    const res = await bibleClient.fetch(jsonUrl, buildBibleFetchOptions(options));
    if (res.ok) {
      try {
        const parsed = await res.json();
        const payload = findBibleNode(parsed, 'guild');
        const members = payload?.guild?.members;
        if (Array.isArray(members)) {
          return members
            .map((entry) => {
              if (!Array.isArray(entry) || entry.length < 4) return null;
              const [memberName, cls, ilvl, rank, combatPower] = entry;
              if (typeof memberName !== 'string' || typeof cls !== 'string') return null;
              return {
                name: memberName,
                cls,
                ilvl: typeof ilvl === 'number' ? ilvl : parseFloat(ilvl),
                rank: typeof rank === 'string' ? rank : '',
                combatPower: combatPower && typeof combatPower === 'object' ? combatPower : null,
              };
            })
            .filter(Boolean);
        }
        console.warn(
          `[alt-detect] /guild/__data.json for ${name} missing members array; falling back to HTML.`
        );
      } catch (jsonErr) {
        console.warn(
          `[alt-detect] /guild/__data.json parse failed for ${name}: ${jsonErr.message}; falling back to HTML.`
        );
      }
    }

    const htmlRes = await bibleClient.fetch(htmlUrl, buildBibleFetchOptions(options));
    if (!htmlRes.ok) return [];
    const html = await htmlRes.text();
    return parseGuildMembersFromHtml(html);
  } catch (err) {
    console.warn('[alt-detect] Failed to fetch guild members:', err.message);
    return [];
  }
}

export async function fetchGuildMembers(name, options = {}) {
  const cacheKey = options.cacheKey || options.guildName || name;
  const useCache = options.useCache !== false;

  if (useCache) {
    const cached = getCachedGuildMembers(cacheKey);
    if (cached !== undefined) return cached;

    const inFlightKey = buildGuildMembersInflightKey(cacheKey, options);
    const inFlight = inFlightGuildMemberFetches.get(inFlightKey);
    if (inFlight) return inFlight;

    const fetchPromise = fetchGuildMembersUncached(name, options)
      .then((members) => {
        setCachedGuildMembers(cacheKey, members);
        return members;
      })
      .finally(() => {
        inFlightGuildMemberFetches.delete(inFlightKey);
      });
    inFlightGuildMemberFetches.set(inFlightKey, fetchPromise);
    return fetchPromise;
  }

  return fetchGuildMembersUncached(name, options);
}
