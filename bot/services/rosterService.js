import { JSDOM } from 'jsdom';

import config from '../../config.js';
import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import { getClassName } from '../../models/Class.js';
import { getAddedByDisplay } from '../utils/names.js';

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
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
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

  try {
    const targetUrl = `https://lostark.bible/character/NA/${name}/roster`;
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
    if (response.ok) {
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
    console.warn('[list] Failed to fetch roster characters:', err.message);
  }

  return { hasValidRoster, allCharacters };
}

export async function handleRosterBlackListCheck(names) {
  try {
    console.log(`[blacklist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    const allDocs = await Blacklist.find({}).lean();
    console.log(`[blacklist] Total docs in DB: ${allDocs.length}`);

    for (const charName of names) {
      const entry = await Blacklist.findOne({ name: charName })
        .collation({ locale: 'en', strength: 2 })
        .lean();
      if (entry) {
        console.log(`[blacklist] ⛔ "${charName}" is BLACKLISTED — reason: ${entry.reason || '(none)'}`);
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

    for (const charName of names) {
      const entry = await Whitelist.findOne({ name: charName })
        .collation({ locale: 'en', strength: 2 })
        .lean();
      if (entry) {
        console.log(`[whitelist] ✅ "${charName}" is WHITELISTED — reason: ${entry.reason || '(none)'}`);
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
