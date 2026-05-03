import config from '../../config.js';
import { findBibleNode } from '../../utils/bibleData.js';
import { buildBibleFetchOptions, fetchWithFallback } from './bibleFetch.js';
import { parseGuildMembersFromHtml } from './parsers.js';

const guildMembersCache = new Map();
const inFlightGuildMemberFetches = new Map();

function normalizeGuildMembersCacheKey(key) {
  return String(key || '').trim().toLowerCase();
}

function getCachedGuildMembers(cacheKey) {
  const key = normalizeGuildMembersCacheKey(cacheKey);
  if (!key) return undefined;
  const entry = guildMembersCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    guildMembersCache.delete(key);
    return undefined;
  }
  guildMembersCache.delete(key);
  guildMembersCache.set(key, entry);
  return entry.members;
}

function setCachedGuildMembers(cacheKey, members) {
  const key = normalizeGuildMembersCacheKey(cacheKey);
  if (!key || !Array.isArray(members) || members.length === 0) return;
  if (guildMembersCache.size >= config.guildMembersCacheMaxSize) {
    const firstKey = guildMembersCache.keys().next().value;
    guildMembersCache.delete(firstKey);
  }
  guildMembersCache.set(key, {
    members,
    expiresAt: Date.now() + config.guildMembersCacheTtlMs,
  });
}

export function clearGuildMembersCache() {
  guildMembersCache.clear();
  inFlightGuildMemberFetches.clear();
}

async function fetchGuildMembersUncached(name, options = {}) {
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild`;
    const res = await fetchWithFallback(jsonUrl, buildBibleFetchOptions(options));
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

    const htmlRes = await fetchWithFallback(htmlUrl, buildBibleFetchOptions(options));
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

    const normalizedKey = normalizeGuildMembersCacheKey(cacheKey);
    const inFlight = inFlightGuildMemberFetches.get(normalizedKey);
    if (inFlight) return inFlight;

    const fetchPromise = fetchGuildMembersUncached(name, options)
      .then((members) => {
        setCachedGuildMembers(cacheKey, members);
        return members;
      })
      .finally(() => {
        inFlightGuildMemberFetches.delete(normalizedKey);
      });
    inFlightGuildMemberFetches.set(normalizedKey, fetchPromise);
    return fetchPromise;
  }

  return fetchGuildMembersUncached(name, options);
}
