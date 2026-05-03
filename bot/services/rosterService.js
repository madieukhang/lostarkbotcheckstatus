import { JSDOM, VirtualConsole } from 'jsdom';

import config from '../config.js';
import { connectDB } from '../db.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import { getClassName } from '../models/Class.js';
import { getAddedByDisplay } from '../utils/names.js';
import { buildBlacklistQuery } from '../utils/scope.js';
import { decodeBibleData, findBibleNode } from '../utils/bibleData.js';
import {
  configureMetaCache,
  getCachedMeta,
  setCachedMeta,
} from '../utils/metaCache.js';

// Boot-time configuration so the cache picks up env-driven TTL/size
// before any fetchCharacterMeta caller runs.
configureMetaCache({
  ttlMs: config.metaCacheTtlMs,
  maxSize: config.metaCacheMaxSize,
});

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => {});
virtualConsole.on('jsdomError', (err) => {
  if (err?.type === 'css parsing') return;
  console.warn('[jsdom] Parse warning:', err?.message || err);
});

/**
 * Smart fallback cache — remembers when direct fetch is blocked by Cloudflare.
 * Skips the wasted direct request for BLOCK_CACHE_MS after a 403/503.
 */
let directBlockedUntil = 0;
const BLOCK_CACHE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Exhausted/invalid key tracking — skip dead keys for KEY_COOLDOWN_MS.
 * Status 401/403 (invalid key) or 429 (quota exhausted) marks key as dead.
 */
const deadKeysUntil = new Map(); // key → timestamp when can retry
const KEY_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Try fetching via ScraperAPI with a specific key.
 * Returns { res, keyDead } — keyDead=true means this key is exhausted/invalid.
 */
async function tryScraperApi(url, key, keyIndex) {
  const proxyUrl = `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(30000) });
    // ScraperAPI returns 401/403 for invalid key, 429 for quota exhausted
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      const body = await res.text().catch(() => '');
      console.warn(`[scraperapi] Key #${keyIndex + 1} failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
      deadKeysUntil.set(key, Date.now() + KEY_COOLDOWN_MS);
      return { res, keyDead: true };
    }
    return { res, keyDead: false };
  } catch (err) {
    console.warn(`[scraperapi] Key #${keyIndex + 1} network error: ${err.message}`);
    return { res: null, keyDead: false, error: err };
  }
}

/**
 * Fetch a URL via ScraperAPI, trying keys in order until one succeeds.
 * Dead keys (exhausted/invalid) are skipped for KEY_COOLDOWN_MS.
 */
async function fetchViaScraperApi(url) {
  const keys = config.scraperApiKeys || [];
  if (keys.length === 0) return null;

  const errors = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const deadUntil = deadKeysUntil.get(key) || 0;
    if (Date.now() < deadUntil) {
      errors.push(`Key #${i + 1}: skipped (cooling down)`);
      continue;
    }

    const { res, keyDead, error } = await tryScraperApi(url, key, i);
    if (error) { errors.push(`Key #${i + 1}: ${error.message}`); continue; }
    if (keyDead) { errors.push(`Key #${i + 1}: HTTP ${res.status}`); continue; }
    if (res.ok) {
      console.log(`[scraperapi] Key #${i + 1} success`);
      return res;
    }
    // Non-2xx but not a key problem — return as-is (target site error)
    return res;
  }

  console.error(`[scraperapi] All ${keys.length} key(s) failed: ${errors.join(' | ')}`);
  return null;
}

/**
 * Fetch a URL with automatic ScraperAPI fallback on 403/503.
 * Uses smart cache: if recently blocked, skips direct fetch and goes straight to ScraperAPI.
 * Multi-key fallback: if key #1 is exhausted, tries key #2, etc.
 *
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(url, options = {}) {
  const {
    allowScraperApi = true,
    preferScraperApi = false,
    fallbackOnRateLimit = false,
    ...fetchOptions
  } = options;
  const hasKey = allowScraperApi && config.scraperApiKeys?.length > 0;

  if (preferScraperApi && hasKey) {
    const proxyRes = await fetchViaScraperApi(url);
    if (proxyRes) return proxyRes;
    console.warn(`[fetch] ScraperAPI preferred but unavailable, falling back to direct fetch: ${url}`);
  }

  // If recently blocked, skip direct fetch → ScraperAPI immediately
  if (Date.now() < directBlockedUntil && hasKey) {
    const res = await fetchViaScraperApi(url);
    if (res) return res;
    // All keys dead — fall through to direct fetch as last resort
    console.warn(`[fetch] All ScraperAPI keys dead, attempting direct fetch despite cache: ${url}`);
  }

  let res;
  try {
    res = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(15000),
      ...fetchOptions,
    });
  } catch (err) {
    console.warn(`[fetch] Direct fetch failed: ${err.message}`);
    if (hasKey) {
      const proxyRes = await fetchViaScraperApi(url);
      if (proxyRes) return proxyRes;
    }
    throw err;
  }

  if ((res.status === 403 || res.status === 503 || (res.status === 429 && fallbackOnRateLimit)) && hasKey) {
    if (res.status === 403 || res.status === 503) {
      directBlockedUntil = Date.now() + BLOCK_CACHE_MS;
    }
    console.warn(`[fetch] ${res.status} on direct fetch. Falling back to ScraperAPI: ${url}`);
    const proxyRes = await fetchViaScraperApi(url);
    if (proxyRes) return proxyRes;
    console.error(`[fetch] All ScraperAPI fallbacks failed for ${url}, returning original ${res.status}`);
  }

  return res;
}

export function extractRosterClassMapFromHtml(html) {
  const rosterClassMap = new Map();
  const regex = /name:\"([^\"]+)\",class:\"([^\"]+)\"/g;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, charName, clsId] = match;
    if (!charName || !clsId) continue;
    rosterClassMap.set(charName, clsId);
  }

  return rosterClassMap;
}

/**
 * Search for similar character names via lostark.bible API.
 * @returns {Array|null} Array of suggestions, or null on API error (403/network)
 */
export async function fetchNameSuggestions(name) {
  try {
    const payload = Buffer.from(JSON.stringify([{"name":1,"region":2}, name, 'NA'])).toString('base64');
    const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
    const res = await fetchWithFallback(targetUrl);
    if (!res.ok) {
      console.warn(`[search] lostark.bible search API returned HTTP ${res.status} for "${name}"`);
      return null; // API error — distinct from "no results"
    }

    const json = await res.json();
    if (json.type !== 'result' || !json.result) return [];

    const data = JSON.parse(json.result);
    if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length === 0) return [];

    return data[0]
      .map((p) => {
        const group = data[p];
        if (!Array.isArray(group) || group.length < 3) return null;
        const [nameIdx, classIdx, ilvlIdx] = group;
        const charName = data[nameIdx];
        if (!charName || typeof charName !== 'string') return null;
        return {
          name: charName,
          cls: data[classIdx] ?? '',
          itemLevel: data[ilvlIdx] ?? 0,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[search] fetchNameSuggestions error for "${name}":`, err.message);
    return null; // network/parse error
  }
}

function parseItemLevelValue(value) {
  const parsed = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractCharacterItemLevelFromHtml(html) {
  const patterns = [
    /itemLevel:(\d+(?:\.\d+)?)/,
    /itemLevel:"([\d,.]+)"/,
    /"itemLevel":(\d+(?:\.\d+)?)/,
    /"itemLevel":"([\d,.]+)"/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;

    const itemLevel = parseItemLevelValue(match[1]);
    if (itemLevel !== null) return itemLevel;
  }

  return null;
}

async function inferHiddenRosterItemLevel(name) {
  const suggestions = await fetchNameSuggestions(name);
  const exact = suggestions?.find((s) => s.name?.toLowerCase() === name.toLowerCase());
  return exact ? parseItemLevelValue(exact.itemLevel) : null;
}

export async function buildRosterCharacters(name, options = {}) {
  const {
    hiddenRosterFallback = false,
    includeHiddenRosterAlts = false,
  } = options;

  let allCharacters = [name];
  let hasValidRoster = false;
  let failReason = null;
  let targetItemLevel = null;
  let rosterVisibility = 'missing';

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await fetchWithFallback(targetUrl);

    if (!response.ok) {
      failReason = response.status === 429 ? 'Rate limited — try again later' : `HTTP ${response.status}`;
    } else {
      const html = await response.text();
      const { document } = new JSDOM(html, { virtualConsole }).window;
      const links = document.querySelectorAll('a[href^="/character/NA/"]');
      const rosterChars = [];

      for (const link of links) {
        const headerDiv = link.querySelector('.text-lg.font-semibold');
        if (!headerDiv) continue;

        const charName = [...headerDiv.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .find((t) => t.length > 0);

        if (!charName) continue;

        rosterChars.push(charName);

        // Extract ilvl for the target character
        if (charName.toLowerCase() === name.toLowerCase()) {
          const spans = headerDiv.querySelectorAll('span');
          const ilvlText = spans[0]?.textContent.trim() ?? '';
          const parsed = parseFloat(ilvlText.replace(/,/g, ''));
          if (!isNaN(parsed)) targetItemLevel = parsed;
        }
      }

      if (rosterChars.length > 0) {
        hasValidRoster = true;
        rosterVisibility = 'visible';
        allCharacters = [...new Set(rosterChars)];
      } else if (hiddenRosterFallback) {
        const meta = await fetchCharacterMeta(name);
        if (meta) {
          hasValidRoster = true;
          rosterVisibility = 'hidden';
          targetItemLevel = await inferHiddenRosterItemLevel(name) ?? meta.itemLevel;
          allCharacters = [name];

          if (includeHiddenRosterAlts && meta.guildName) {
            const altResult = await detectAltsViaStronghold(name, { targetMeta: meta });
            const altNames = altResult?.alts?.map((alt) => alt.name).filter(Boolean) ?? [];
            allCharacters = [...new Set([name, ...altNames])];
          }
        }
      }
    }
  } catch (err) {
    failReason = err.name === 'TimeoutError' ? 'timeout' : err.message;
    console.warn('[list] Failed to fetch roster characters:', err.message);
  }

  return { hasValidRoster, allCharacters, failReason, targetItemLevel, rosterVisibility };
}

export async function handleRosterBlackListCheck(names, options = {}) {
  try {
    await connectDB();

    const { guildId } = options;
    const nameQuery = { $or: [{ name: { $in: names } }, { allCharacters: { $in: names } }] };

    const entry = await Blacklist.findOne(buildBlacklistQuery(nameQuery, guildId))
      .sort({ scope: -1 }) // prefer server > global
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[blacklist] ⛔ "${entry.name}" is BLACKLISTED — reason: ${entry.reason || '(none)'}`);
      return {
        name: entry.name,
        reason: entry.reason ?? '',
        raid: entry.raid ?? '',
        imageUrl: entry.imageUrl ?? '',
        // Rehost refs — handler resolves a fresh URL via imageRehost helpers
        imageMessageId: entry.imageMessageId ?? '',
        imageChannelId: entry.imageChannelId ?? '',
        addedByDisplayName: entry.addedByDisplayName ?? '',
        addedByName: entry.addedByName ?? '',
        addedByTag: entry.addedByTag ?? '',
        addedByUserId: entry.addedByUserId ?? '',
      };
    }

    console.log('[blacklist] ✅ No blacklisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[blacklist] ❌ Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

export async function handleRosterWhiteListCheck(names) {
  try {
    console.log(`[whitelist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    const entry = await Whitelist.findOne({
      $or: [
        { name: { $in: names } },
        { allCharacters: { $in: names } },
      ],
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[whitelist] ✅ "${entry.name}" is WHITELISTED — reason: ${entry.reason || '(none)'}`);
      return {
        name: entry.name,
        reason: entry.reason ?? '',
        raid: entry.raid ?? '',
        imageUrl: entry.imageUrl ?? '',
        // Rehost refs — handler resolves a fresh URL via imageRehost helpers
        imageMessageId: entry.imageMessageId ?? '',
        imageChannelId: entry.imageChannelId ?? '',
        addedByDisplayName: entry.addedByDisplayName ?? '',
        addedByName: entry.addedByName ?? '',
        addedByTag: entry.addedByTag ?? '',
        addedByUserId: entry.addedByUserId ?? '',
      };
    }

    console.log('[whitelist] No whitelisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[whitelist] ❌ Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

export async function parseRosterCharactersFromHtml(html, document) {
  const rosterClassMap = extractRosterClassMapFromHtml(html);
  const characters = [];
  const links = document.querySelectorAll('a[href^="/character/NA/"]');

  for (const link of links) {
    const headerDiv = link.querySelector('.text-lg.font-semibold');
    if (!headerDiv) continue;

    const charName = [...headerDiv.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .find((t) => t.length > 0);

    const spans = headerDiv.querySelectorAll('span');
    const itemLevel = spans[0]?.textContent.trim() ?? '?';
    const combatScore = spans[1]?.textContent.trim() ?? '?';
    const classId = charName ? rosterClassMap.get(charName) ?? '' : '';
    const className = getClassName(classId);

    if (charName) characters.push({ name: charName, itemLevel, combatScore, classId, className });
  }

  return characters;
}

// ─── Alt detection via Stronghold fingerprint ────────────────────────────────

export const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

/**
 * Fetch a character's meta from lostark.bible (Stronghold, Roster Level, Guild).
 * Uses direct fetch (no ScraperAPI) since lostark.bible character pages are accessible.
 * @param {string} name
 * @returns {Promise<object|null>}
 */
/**
 * Last-resort fallback parser used when the JSON endpoint format
 * shifts under us. Mirrors the legacy regex behavior exactly so
 * callers downstream see the same shape they did before the JSON
 * migration.
 */
function parseCharacterMetaFromHtml(html) {
  const rlMatch = html.match(/rosterLevel:(\d+)/);
  const shMatch = html.match(/stronghold:\{[^}]*level:(\d+),name:"([^"]+)"\}/);
  const guildMatch = html.match(/guild:\{name:"([^"]+)",grade:"([^"]+)"\}/);
  const itemLevel = extractCharacterItemLevelFromHtml(html);
  let classId = '';
  if (rlMatch) {
    const beforeRL = html.substring(Math.max(0, rlMatch.index - 500), rlMatch.index);
    const classMatch = beforeRL.match(/class:"([^"]+)"/);
    if (classMatch) classId = classMatch[1];
  }
  if (!rlMatch || !shMatch) return null;
  return {
    rosterLevel: parseInt(rlMatch[1]),
    strongholdLevel: parseInt(shMatch[1]),
    strongholdName: shMatch[2],
    guildName: guildMatch ? guildMatch[1] : null,
    guildGrade: guildMatch ? guildMatch[2] : null,
    classId,
    itemLevel,
  };
}

/**
 * Map the SvelteKit `header` payload into the legacy meta shape used
 * by alt-detect callers. Returns null when the header lacks the
 * load-bearing fields so the caller can fall back to HTML.
 */
function shapeCharacterMetaFromHeader(header) {
  if (!header || typeof header.rosterLevel !== 'number') return null;
  const stronghold = header.stronghold || {};
  const guild = header.guild || null;
  if (typeof stronghold.level !== 'number' || !stronghold.name) return null;
  return {
    rosterLevel: header.rosterLevel,
    strongholdLevel: stronghold.level,
    strongholdName: stronghold.name,
    guildName: guild?.name ?? null,
    guildGrade: guild?.grade ?? null,
    classId: typeof header.class === 'string' ? header.class : '',
    itemLevel: typeof header.ilvl === 'number' ? header.ilvl : null,
  };
}

export async function fetchCharacterMeta(name, options = {}) {
  // Migrated from regex-on-HTML to SvelteKit `__data.json` parsing.
  // Same network shape (single GET per character) so 429 surface and
  // ScraperAPI fallback semantics are unchanged - the change is in
  // parse path only: structured JSON instead of fragile regex on
  // hydration script. HTML scrape kept as a defensive fallback because
  // bible's __data.json layout is internal and could shift on a deploy.
  //
  // Cache layer (Phase 2): successful results are cached in a 30-min
  // LRU+TTL store so back-to-back /roster deep and /list enrich on the
  // same character cluster do not refetch. Caller can opt out with
  // `useCache: false`. Transient failures (null results) are NOT
  // cached to avoid pinning a 429 outage into the cache.
  if (options.useCache !== false) {
    const cached = getCachedMeta(name);
    if (cached !== undefined) return cached;
  }
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}`;
    const fetchOptions = {
      allowScraperApi: options.allowScraperApi !== false,
      preferScraperApi: options.preferScraperApi === true,
      fallbackOnRateLimit: options.fallbackOnRateLimit === true,
    };
    if (options.timeoutMs) {
      fetchOptions.signal = AbortSignal.timeout(options.timeoutMs);
    }
    let res = await fetchWithFallback(jsonUrl, fetchOptions);

    // Handle rate limit: wait and retry once. Same policy as the
    // legacy regex path - one retry with a 5s pause covers transient
    // bursts without piling on the limiter.
    if (res.status === 429 && options.retryOnRateLimit !== false) {
      console.warn(`[alt-detect] 429 rate-limited on ${name}, waiting 5s to retry...`);
      await new Promise((r) => setTimeout(r, 5000));
      res = await fetchWithFallback(jsonUrl, fetchOptions);
    }

    if (res.ok) {
      try {
        const parsed = await res.json();
        const payload = findBibleNode(parsed, 'header');
        const shaped = shapeCharacterMetaFromHeader(payload?.header);
        if (shaped) return shaped;
        console.warn(
          `[alt-detect] __data.json for ${name} did not contain expected header shape; falling back to HTML.`
        );
      } catch (jsonErr) {
        console.warn(
          `[alt-detect] __data.json parse failed for ${name}: ${jsonErr.message}; falling back to HTML.`
        );
      }
    }

    // HTML fallback: the JSON endpoint either returned a non-2xx, an
    // unparseable body, or a payload missing the expected fields.
    const htmlRes = await fetchWithFallback(htmlUrl, fetchOptions);
    if (!htmlRes.ok) return null;
    const html = await htmlRes.text();
    return parseCharacterMetaFromHtml(html);
  } catch (err) {
    console.warn(`[alt-detect] Failed to fetch meta for ${name}:`, err.message);
    return null;
  }
}

/**
 * Last-resort HTML fallback for guild member extraction. Same regex as
 * the pre-migration legacy path so the alt-detect contract survives a
 * bible JSON layout shift untouched.
 */
function parseGuildMembersFromHtml(html) {
  const memberPattern = /\["([^"]+)","([^"]+)",([\d.]+),"([^"]+)"/g;
  const out = [];
  let m;
  while ((m = memberPattern.exec(html)) !== null) {
    out.push({ name: m[1], cls: m[2], ilvl: parseFloat(m[3]), rank: m[4] });
  }
  return out;
}

/**
 * Fetch guild member list from a character's guild tab on lostark.bible.
 *
 * Migrated to consume `__data.json` instead of regex-scraping the page
 * HTML. The structured payload exposes the member list as a flat
 * tuple-array `[name, classId, ilvl, rank, combatPower|null]` under
 * `nodes[2].guild.members`. This is the same data the legacy regex
 * was reaching into the hydration blob to retrieve, just no longer
 * dependent on the surrounding HTML staying byte-stable.
 *
 * Bonus over the legacy path: `combatPower` is now surfaced (the regex
 * only captured the first four positional fields). Callers that ignore
 * the field continue to work because it is appended, not interleaved.
 *
 * @param {string} name - Character name (must be in a guild)
 * @returns {Promise<Array<{name, cls, ilvl, rank, combatPower}>>}
 */
export async function fetchGuildMembers(name) {
  try {
    const jsonUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild/__data.json`;
    const htmlUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild`;
    const res = await fetchWithFallback(jsonUrl);
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

    // HTML fallback path - same regex behavior as the pre-migration
    // implementation. Returns [] on any error so deep scan can short
    // circuit to "no candidates" rather than throwing.
    const htmlRes = await fetchWithFallback(htmlUrl);
    if (!htmlRes.ok) return [];
    const html = await htmlRes.text();
    return parseGuildMembersFromHtml(html);
  } catch (err) {
    console.warn('[alt-detect] Failed to fetch guild members:', err.message);
    return [];
  }
}

export async function detectAltsViaStronghold(name, options = {}) {
  console.log(`[alt-detect] Starting alt detection for ${name}...`);
  const candidateLimit = options.candidateLimit ?? config.strongholdDeepCandidateLimit;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? config.strongholdDeepConcurrency, 12));
  const candidateTimeoutMs = options.candidateTimeoutMs ?? config.strongholdDeepCandidateTimeoutMs;
  const useScraperApiForCandidates = options.useScraperApiForCandidates ?? config.strongholdDeepUseScraperApi;

  const meta = options.targetMeta || await fetchCharacterMeta(name);
  if (!meta) {
    console.log('[alt-detect] No character meta found.');
    return null;
  }
  if (!meta.guildName) {
    console.log('[alt-detect] Character has no guild.');
    return null;
  }
  if (!meta.strongholdName) {
    console.log('[alt-detect] No stronghold data.');
    return null;
  }

  const targetItemLevel = options.targetItemLevel ?? await inferHiddenRosterItemLevel(name) ?? meta.itemLevel;

  console.log(`[alt-detect] Target: SH "${meta.strongholdName}" Lv.${meta.strongholdLevel}, RL ${meta.rosterLevel}, Guild "${meta.guildName}"`);

  const members = await fetchGuildMembers(name);
  if (members.length === 0) {
    console.log('[alt-detect] No guild members found.');
    return null;
  }

  console.log(`[alt-detect] Guild has ${members.length} members. Checking for Stronghold matches...`);

  const candidates = members
    .filter((m) => m.name !== name && m.ilvl >= 1700)
    .sort((a, b) => (b.ilvl || 0) - (a.ilvl || 0));
  const limitedCandidates = candidateLimit > 0 ? candidates.slice(0, candidateLimit) : candidates;
  const skippedCandidates = Math.max(0, candidates.length - limitedCandidates.length);
  console.log(
    `[alt-detect] ${candidates.length} candidate(s) after filtering ilvl >= 1700; scanning ${limitedCandidates.length}`
    + (skippedCandidates > 0 ? `, skipping ${skippedCandidates} by limit` : '')
    + `. Candidate ScraperAPI: ${useScraperApiForCandidates ? 'on' : 'off'}. Concurrency: ${concurrency}.`
  );

  const alts = [];
  let failedCandidates = 0;
  let scannedCandidates = 0;
  let nextCandidateIndex = 0;

  console.log(`[alt-detect] Scanning ${limitedCandidates.length} candidate(s)...`);

  // Shared adaptive backoff state across all workers in this scan.
  // Each iteration pauses `current` ms before the next fetch. When any
  // worker observes a transient failure (null result), `current` grows
  // by `step` up to `max` so all workers slow down together. A clean
  // success shrinks it by `recover` down to `min` for gradual recovery.
  // Starts at the minimum so a healthy bible runs at the floor pace.
  const backoff = {
    current: config.scanBackoffMinMs,
    min: config.scanBackoffMinMs,
    max: config.scanBackoffMaxMs,
    step: 500,
    recover: 100,
  };

  async function scanWorker() {
    while (nextCandidateIndex < limitedCandidates.length) {
      const cand = limitedCandidates[nextCandidateIndex++];
      const candMeta = await fetchCharacterMeta(cand.name, {
        allowScraperApi: useScraperApiForCandidates,
        preferScraperApi: useScraperApiForCandidates,
        fallbackOnRateLimit: useScraperApiForCandidates,
        retryOnRateLimit: false,
        timeoutMs: candidateTimeoutMs,
      });

      scannedCandidates++;
      if (candMeta === null) {
        failedCandidates++;
        backoff.current = Math.min(backoff.current + backoff.step, backoff.max);
      } else {
        backoff.current = Math.max(backoff.current - backoff.recover, backoff.min);
        if (candMeta.strongholdName === meta.strongholdName && candMeta.rosterLevel === meta.rosterLevel) {
          alts.push({
            name: cand.name,
            classId: cand.cls,
            className: getClassName(cand.cls),
            itemLevel: cand.ilvl,
            rank: cand.rank,
          });
          console.log(`[alt-detect] Match found: ${cand.name}`);
        }
      }

      if (scannedCandidates % 25 === 0 || scannedCandidates === limitedCandidates.length) {
        console.log(
          `[alt-detect] Progress ${scannedCandidates}/${limitedCandidates.length};` +
          ` failed ${failedCandidates}; alts ${alts.length}; backoff ${backoff.current}ms`
        );
      }

      // Inter-iteration pause to give bible breathing room. Skip on the
      // last candidate so the worker exits promptly instead of waiting
      // for nothing.
      if (nextCandidateIndex < limitedCandidates.length) {
        await new Promise((r) => setTimeout(r, backoff.current));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, limitedCandidates.length) }, () => scanWorker())
  );

  console.log(`[alt-detect] Found ${alts.length} alt(s) for ${name}.`);

  return {
    target: {
      name,
      classId: meta.classId,
      className: getClassName(meta.classId),
      itemLevel: targetItemLevel,
      rosterLevel: meta.rosterLevel,
      strongholdName: meta.strongholdName,
      strongholdLevel: meta.strongholdLevel,
      guildName: meta.guildName,
      guildGrade: meta.guildGrade,
    },
    alts,
    totalMembers: members.length,
    scannedCandidates,
    skippedCandidates,
    failedCandidates,
    candidateLimit,
    concurrency,
    candidateTimeoutMs,
    usedScraperApiForCandidates: useScraperApiForCandidates,
  };
}

export function formatSuggestionLines(suggestions) {
  return suggestions
    .map((s) => `[${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel).toFixed(2)}\` — ${getClassName(s.cls)}`)
    .join('\n');
}

export function buildRosterStatusContent(name, result, label) {
  const reason = result.reason ? ` — *${result.reason}*` : '';
  const raid = result.raid ? ` [${result.raid}]` : '';
  return `${label} **${name}**${label === '⛔' ? ' is on the blacklist.' : ' is on the whitelist.'}${raid}${reason}`;
}
