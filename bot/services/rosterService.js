import { JSDOM } from 'jsdom';

import config from '../../config.js';
import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import { getClassName } from '../../models/Class.js';
import { getAddedByDisplay } from '../utils/names.js';

/**
 * Fetch a URL with automatic ScraperAPI fallback on 403.
 * Tries direct fetch first (fast). If blocked (403/503), retries via ScraperAPI proxy.
 *
 * @param {string} url
 * @param {object} [options]
 * @returns {Promise<Response>}
 */
export async function fetchWithFallback(url, options = {}) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
    ...options,
  });

  if ((res.status === 403 || res.status === 503) && config.scraperApiKey) {
    console.warn(`[fetch] ${res.status} on direct fetch, falling back to ScraperAPI: ${url}`);
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(url)}`;
    return fetch(proxyUrl, { signal: AbortSignal.timeout(30000) });
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

export async function fetchNameSuggestions(name) {
  try {
    const payload = Buffer.from(JSON.stringify([[1, 2], name, 'NA'])).toString('base64');
    const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
    const res = await fetchWithFallback(targetUrl);
    if (!res.ok) return [];

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
  } catch {
    return [];
  }
}

export async function buildRosterCharacters(name) {
  let allCharacters = [name];
  let hasValidRoster = false;
  let failReason = null;

  try {
    const targetUrl = `https://lostark.bible/character/NA/${name}/roster`;
    const response = await fetchWithFallback(targetUrl);

    if (!response.ok) {
      failReason = `HTTP ${response.status}`;
    } else {
      const html = await response.text();
      const { document } = new JSDOM(html).window;
      const links = document.querySelectorAll('a[href^="/character/NA/"]');
      const rosterChars = [];

      for (const link of links) {
        const headerDiv = link.querySelector('.text-lg.font-semibold');
        if (!headerDiv) continue;

        const charName = [...headerDiv.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .find((t) => t.length > 0);

        if (charName) rosterChars.push(charName);
      }

      if (rosterChars.length > 0) {
        hasValidRoster = true;
        allCharacters = [...new Set(rosterChars)];
      }
    }
  } catch (err) {
    failReason = err.name === 'TimeoutError' ? 'timeout' : err.message;
    console.warn('[list] Failed to fetch roster characters:', err.message);
  }

  return { hasValidRoster, allCharacters, failReason };
}

export async function handleRosterBlackListCheck(names) {
  try {
    console.log(`[blacklist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    const docCount = await Blacklist.countDocuments();
    console.log(`[blacklist] Total docs in DB: ${docCount}`);

    const entry = await Blacklist.findOne({
      $or: [
        { name: { $in: names } },
        { allCharacters: { $in: names } },
      ],
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[blacklist] ⛔ "${entry.name}" is BLACKLISTED — reason: ${entry.reason || '(none)'}`);
      return {
        name: entry.name,
        reason: entry.reason ?? '',
        raid: entry.raid ?? '',
        imageUrl: entry.imageUrl ?? '',
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
export async function fetchCharacterMeta(name) {
  try {
    const url = `https://lostark.bible/character/NA/${encodeURIComponent(name)}`;
    let res = await fetchWithFallback(url);

    // Handle rate limit: wait and retry once
    if (res.status === 429) {
      console.warn(`[alt-detect] 429 rate-limited on ${name}, waiting 5s to retry...`);
      await new Promise((r) => setTimeout(r, 5000));
      res = await fetchWithFallback(url);
    }

    if (!res.ok) return null;

    const html = await res.text();

    const rlMatch = html.match(/rosterLevel:(\d+)/);
    const shMatch = html.match(/stronghold:\{[^}]*level:(\d+),name:"([^"]+)"\}/);
    const guildMatch = html.match(/guild:\{name:"([^"]+)",grade:"([^"]+)"\}/);
    const classMatch = html.match(/class:"([^"]+)"/);
    const ilvlMatch = html.match(/itemLevel:([\d.]+)/);

    if (!rlMatch || !shMatch) return null;

    return {
      rosterLevel: parseInt(rlMatch[1]),
      strongholdLevel: parseInt(shMatch[1]),
      strongholdName: shMatch[2],
      guildName: guildMatch ? guildMatch[1] : null,
      guildGrade: guildMatch ? guildMatch[2] : null,
      classId: classMatch ? classMatch[1] : '',
      itemLevel: ilvlMatch ? parseFloat(ilvlMatch[1]) : 0,
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
export async function detectAltsViaStronghold(name) {
  console.log(`[alt-detect] Starting alt detection for ${name}...`);

  // Step 1: Get target's Stronghold + Guild info
  const meta = await fetchCharacterMeta(name);
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

  console.log(`[alt-detect] Target: SH "${meta.strongholdName}" Lv.${meta.strongholdLevel}, RL ${meta.rosterLevel}, Guild "${meta.guildName}"`);

  // Step 2: Get guild member list
  const members = await fetchGuildMembers(name);
  if (members.length === 0) {
    console.log('[alt-detect] No guild members found.');
    return null;
  }

  console.log(`[alt-detect] Guild has ${members.length} members. Checking for Stronghold matches...`);

  // Step 3: Filter to ilvl >= 1700 (endgame relevant) and exclude the target
  const candidates = members.filter((m) => m.name !== name && m.ilvl >= 1700);
  console.log(`[alt-detect] ${candidates.length} candidate(s) after filtering ilvl >= 1700.`);
  const alts = [];

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ── Scan candidates with adaptive delay ──
  // Start fast, slow down when rate-limited.
  console.log(`[alt-detect] Scanning ${candidates.length} candidate(s)...`);
  let currentDelay = 300;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const candMeta = await fetchCharacterMeta(cand.name);

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

    if (i < candidates.length - 1) await delay(currentDelay);
  }

  console.log(`[alt-detect] Found ${alts.length} alt(s) for ${name}.`);

  return {
    target: {
      name,
      classId: meta.classId,
      className: getClassName(meta.classId),
      itemLevel: meta.itemLevel,
      rosterLevel: meta.rosterLevel,
      strongholdName: meta.strongholdName,
      strongholdLevel: meta.strongholdLevel,
      guildName: meta.guildName,
      guildGrade: meta.guildGrade,
    },
    alts,
    totalMembers: members.length,
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
  const addedBy = getAddedByDisplay(result);
  const addedByText = addedBy ? ` — Added by: **${addedBy}**` : '';
  return `${label} **${name}**${label === '⛔' ? ' is on the blacklist.' : ' is on the whitelist.'}${raid}${reason}${addedByText}`;
}
