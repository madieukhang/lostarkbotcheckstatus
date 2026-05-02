import { JSDOM, VirtualConsole } from 'jsdom';

import config from '../config.js';
import { connectDB } from '../db.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import { getClassName } from '../models/Class.js';
import { getAddedByDisplay } from '../utils/names.js';
import { buildBlacklistQuery } from '../utils/scope.js';

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
export async function fetchCharacterMeta(name, options = {}) {
  try {
    const url = `https://lostark.bible/character/NA/${encodeURIComponent(name)}`;
    const fetchOptions = {
      allowScraperApi: options.allowScraperApi !== false,
      preferScraperApi: options.preferScraperApi === true,
      fallbackOnRateLimit: options.fallbackOnRateLimit === true,
    };
    if (options.timeoutMs) {
      fetchOptions.signal = AbortSignal.timeout(options.timeoutMs);
    }
    let res = await fetchWithFallback(url, fetchOptions);

    // Handle rate limit: wait and retry once
    if (res.status === 429 && options.retryOnRateLimit !== false) {
      console.warn(`[alt-detect] 429 rate-limited on ${name}, waiting 5s to retry...`);
      await new Promise((r) => setTimeout(r, 5000));
      res = await fetchWithFallback(url, fetchOptions);
    }

    if (!res.ok) return null;

    const html = await res.text();

    const rlMatch = html.match(/rosterLevel:(\d+)/);
    const shMatch = html.match(/stronghold:\{[^}]*level:(\d+),name:"([^"]+)"\}/);
    const guildMatch = html.match(/guild:\{name:"([^"]+)",grade:"([^"]+)"\}/);
    const itemLevel = extractCharacterItemLevelFromHtml(html);

    // Extract class from near rosterLevel position (avoid matching roster alt data)
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
  } catch (err) {
    console.warn(`[alt-detect] Failed to fetch meta for ${name}:`, err.message);
    return null;
  }
}

/**
 * Fetch guild member list from a character's guild tab on lostark.bible.
 * @param {string} name - Character name (must be in a guild)
 * @returns {Promise<Array<{name, cls, ilvl, rank}>>}
 */
export async function fetchGuildMembers(name) {
  try {
    const url = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/guild`;
    const res = await fetchWithFallback(url);
    if (!res.ok) return [];

    const html = await res.text();
    const memberPattern = /\["([^"]+)","([^"]+)",([\d.]+),"([^"]+)"/g;
    const members = [];
    let m;
    while ((m = memberPattern.exec(html)) !== null) {
      members.push({ name: m[1], cls: m[2], ilvl: parseFloat(m[3]), rank: m[4] });
    }

    return members;
  } catch (err) {
    console.warn('[alt-detect] Failed to fetch guild members:', err.message);
    return [];
  }
}

/**
 * Detect alt characters by matching Stronghold name + Roster Level within a guild.
 * Two characters with the same Stronghold name AND Roster Level are almost certainly
 * on the same account (both are account-wide values).
 *
 * @param {string} name - Target character name
 * @returns {Promise<{target, alts[], totalMembers}|null>}
 */
async function detectAltsViaStrongholdLegacy(name, options = {}) {
  console.log(`[alt-detect] Starting alt detection for ${name}...`);
  const candidateLimit = options.candidateLimit ?? config.strongholdDeepCandidateLimit;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? config.strongholdDeepConcurrency, 12));
  const candidateTimeoutMs = options.candidateTimeoutMs ?? config.strongholdDeepCandidateTimeoutMs;
  const useScraperApiForCandidates = options.useScraperApiForCandidates ?? config.strongholdDeepUseScraperApi;

  // Step 1: Get target's Stronghold + Guild info
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

  // Step 2: Get guild member list
  const members = await fetchGuildMembers(name);
  if (members.length === 0) {
    console.log('[alt-detect] No guild members found.');
    return null;
  }

  console.log(`[alt-detect] Guild has ${members.length} members. Checking for Stronghold matches...`);

  // Step 3: Filter to ilvl >= 1700 (endgame relevant) and exclude the target
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

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── Scan candidates with adaptive delay ──
  // Start fast, slow down when rate-limited.
  console.log(`[alt-detect] Scanning ${limitedCandidates.length} candidate(s)...`);
  let currentDelay = 300;

  for (let i = 0; i < limitedCandidates.length; i++) {
    const cand = limitedCandidates[i];
    const candMeta = await fetchCharacterMeta(cand.name, {
      allowScraperApi: useScraperApiForCandidates,
    });

    if (candMeta === null) {
      // fetchCharacterMeta already retried on 429, so if still null → slow down more
      currentDelay = Math.min(currentDelay + 500, 3000);
    } else if (candMeta.strongholdName === meta.strongholdName && candMeta.rosterLevel === meta.rosterLevel) {
      alts.push({
        name: cand.name,
        classId: cand.cls,
        className: getClassName(cand.cls),
        itemLevel: cand.ilvl,
        rank: cand.rank,
      });
    }

    if (i < limitedCandidates.length - 1) await delay(currentDelay);
  }

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
    scannedCandidates: limitedCandidates.length,
    skippedCandidates,
    candidateLimit,
    usedScraperApiForCandidates: useScraperApiForCandidates,
  };
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
      } else if (candMeta.strongholdName === meta.strongholdName && candMeta.rosterLevel === meta.rosterLevel) {
        alts.push({
          name: cand.name,
          classId: cand.cls,
          className: getClassName(cand.cls),
          itemLevel: cand.ilvl,
          rank: cand.rank,
        });
        console.log(`[alt-detect] Match found: ${cand.name}`);
      }

      if (scannedCandidates % 25 === 0 || scannedCandidates === limitedCandidates.length) {
        console.log(`[alt-detect] Progress ${scannedCandidates}/${limitedCandidates.length}; failed ${failedCandidates}; alts ${alts.length}`);
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
