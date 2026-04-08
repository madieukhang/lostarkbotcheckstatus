/**
 * listCheckService.js
 * Shared logic for checking character names against blacklist/whitelist/watchlist.
 * Used by both /listcheck command and auto-check channel handler.
 */

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import RosterCache from '../../models/RosterCache.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
} from './rosterService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
} from '../utils/names.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Known Lost Ark server/world names to filter from OCR results */
const SERVER_NAMES = new Set([
  'azena', 'avesta', 'galatur', 'karta', 'ladon', 'kharmine',
  'una', 'regulus', 'sasha', 'vykas', 'elgacia', 'thaemine',
  'brelshaza', 'kazeros', 'arcturus', 'enviska', 'valtan', 'mari',
  'akkan', 'vairgrys', 'bergstrom', 'danube', 'mokoko',
]);

/** Gemini OCR prompt for Lost Ark waiting room screenshots */
const GEMINI_PROMPT = [
  'This is a screenshot of a Lost Ark raid waiting room (party finder lobby).',
  'Extract ALL player character names from the party member list, regardless of color.',
  'Ignore all other text: raid names, class names, item levels, buttons, chat messages, server/world names (e.g. Vairgrys, Brelshaza, Thaemine).',
  'Preserve every character exactly as shown, including special letters and diacritics.',
  'Lost Ark names frequently use diacritics: ë, ï, ö, ü, í, é, â, î. Pay close attention to dots/marks above letters.',
  'Keep umlaut letters exactly: ë, ö, ü.',
  'Do NOT convert umlauts to grave-accent letters: ë!=è, ö!=ò, ü!=ù.',
  'Return JSON array only, no markdown, no explanation.',
  'Example output: ["name1","name2"].',
  'If no valid names are found, return [].',
].join(' ');

// ─── Gemini OCR ─────────────────────────────────────────────────────────────

function shouldFailoverGeminiModel(status, bodyText) {
  // 404 = model not found, 429 = rate limit, 503 = overloaded — all should try next model
  if (status === 404 || status === 429 || status === 503) return true;
  const text = (bodyText || '').toLowerCase();
  return (
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('is not found')
  );
}

function filterAndDeduplicateNames(parsed) {
  const names = parsed
    .map((item) => (typeof item === 'string' ? normalizeCharacterName(item) : ''))
    .filter((name) => name && !SERVER_NAMES.has(name.toLowerCase()));

  const seen = new Set();
  const unique = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return unique;
}

/**
 * Extract character names from an image using Gemini OCR.
 * Handles model failover on quota/rate limits and network errors.
 *
 * @param {object} image - Discord attachment or { url, contentType }
 * @returns {Promise<string[]>} Array of normalized character names
 */
export async function extractNamesFromImage(image) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (image.contentType && !image.contentType.startsWith('image/')) {
    throw new Error('Attachment must be an image file.');
  }

  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  if (!imageRes.ok) {
    throw new Error(`Failed to download attachment (HTTP ${imageRes.status})`);
  }

  const contentLength = imageRes.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 20 * 1024 * 1024) {
    throw new Error('Image file too large (max 20MB).');
  }

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const imageBase64 = imageBuffer.toString('base64');

  const requestBody = {
    contents: [{ parts: [{ text: GEMINI_PROMPT }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: { temperature: 0, topP: 0.1, maxOutputTokens: 512 },
  };

  const models = config.geminiModels.length > 0
    ? config.geminiModels
    : ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'];
  const failures = [];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    let aiRes;
    try {
      aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });
    } catch (fetchErr) {
      failures.push(`${model}: ${fetchErr.name || fetchErr.message}`);
      if (i < models.length - 1) {
        console.warn(`[listcheck] Gemini timeout/network error on ${model}, trying fallback model.`);
        continue;
      }
      throw new Error(`Gemini request failed on ${model}: ${fetchErr.message}`);
    }

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);

      const canFallback = i < models.length - 1;
      if (canFallback && shouldFailoverGeminiModel(aiRes.status, errBody)) {
        console.warn(`[listcheck] Gemini quota/rate hit on ${model}, trying fallback model.`);
        continue;
      }

      throw new Error(`Gemini request failed on ${model} (HTTP ${aiRes.status}) ${errBody}`.trim());
    }

    const payload = await aiRes.json();
    const candidate = payload?.candidates?.[0];
    const finishReason = candidate?.finishReason;

    // Filter out thinking parts (thought: true) — only keep actual response text
    const parts = candidate?.content?.parts || [];
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part?.text ?? '')
      .join('')
      .trim();

    if (finishReason && finishReason !== 'STOP') {
      console.warn(`[listcheck] Gemini (${model}) finishReason: ${finishReason}, text: ${text.slice(0, 100)}`);
    }

    if (!text) return [];

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // If this model returned non-JSON, try next model instead of throwing immediately
      const canFallback = i < models.length - 1;
      console.warn(`[listcheck] Gemini (${model}) returned non-JSON text: ${text.slice(0, 200)}`);
      if (canFallback) {
        failures.push(`${model}: non-JSON response`);
        continue;
      }
      throw new Error('Gemini did not return a JSON array.');
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.warn(`[listcheck] Gemini (${model}) JSON parse failed: ${jsonMatch[0].slice(0, 200)}`);
      throw new Error('Gemini returned invalid JSON.');
    }
    if (!Array.isArray(parsed)) throw new Error('Gemini output is not an array.');

    return filterAndDeduplicateNames(parsed);
  }

  throw new Error(`All Gemini models failed: ${failures.join(' | ')}`);
}

// ─── Name checking ──────────────────────────────────────────────────────────

/**
 * Check an array of names against blacklist/whitelist/watchlist.
 * Includes roster check and similar name suggestions for unmatched names.
 *
 * @param {string[]} names
 * @returns {Promise<Array<object>>} Results with list entries, roster status, similar names
 */
/**
 * @param {string[]} names
 * @param {object} [options]
 * @param {string} [options.guildId] - Guild ID for including server-scoped blacklist entries
 */
export async function checkNamesAgainstLists(names, options = {}) {
  await connectDB();
  const { guildId } = options;

  // Phase 1: Batch list check — 3 queries for ALL names instead of 3 × N
  const nameQuery = { $or: [{ name: { $in: names } }, { allCharacters: { $in: names } }] };
  const collation = { locale: 'en', strength: 2 };

  // Blacklist: include global + server-scoped entries for this guild
  const blackQuery = {
    $and: [
      nameQuery,
      { $or: [
        { scope: 'global' },
        { scope: { $exists: false } }, // backward compat for old entries
        ...(guildId ? [{ scope: 'server', guildId }] : []),
      ] },
    ],
  };

  const [allBlack, allWhite, allWatch] = await Promise.all([
    Blacklist.find(blackQuery).collation(collation).lean(),
    Whitelist.find(nameQuery).collation(collation).lean(),
    Watchlist.find(nameQuery).collation(collation).lean(),
  ]);

  // Build O(1) lookup maps from list entries (once per list, not per name)
  function buildEntryMap(entries) {
    const map = new Map();
    for (const e of entries) {
      map.set(e.name.toLowerCase(), e);
      for (const c of (e.allCharacters || [])) {
        if (!map.has(c.toLowerCase())) map.set(c.toLowerCase(), e);
      }
    }
    return map;
  }

  const blackMap = buildEntryMap(allBlack);
  const whiteMap = buildEntryMap(allWhite);
  const watchMap = buildEntryMap(allWatch);

  const results = names.map((name) => ({
    name,
    blackEntry: blackMap.get(name.toLowerCase()) || null,
    whiteEntry: whiteMap.get(name.toLowerCase()) || null,
    watchEntry: watchMap.get(name.toLowerCase()) || null,
    hasRoster: false,
    failReason: null,
    similarNames: null,
  }));

  // Phase 2: Sequential roster check for unflagged names
  // Batch read all RosterCache entries at once, then process
  const unflaggedNames = results
    .filter((r) => !r.blackEntry && !r.whiteEntry && !r.watchEntry)
    .map((r) => r.name);

  const cachedEntries = unflaggedNames.length > 0
    ? await RosterCache.find({ name: { $in: unflaggedNames } }).collation(collation).lean()
    : [];
  const cacheMap = new Map(cachedEntries.map((c) => [c.name.toLowerCase(), c]));

  for (const item of results) {
    if (item.blackEntry || item.whiteEntry || item.watchEntry) continue;

    const cached = cacheMap.get(item.name.toLowerCase());

    if (cached) {
      item.hasRoster = cached.hasRoster;
      item.failReason = cached.failReason || null;
      if (cached.searchSuggestions?.length > 0) {
        item.similarNames = cached.searchSuggestions;
      }
      console.log(`[listcheck] Cache hit: ${item.name} (hasRoster: ${cached.hasRoster})`);
    } else {
      // Cache miss → fetch from lostark.bible
      const rosterResult = await buildRosterCharacters(item.name);
      item.hasRoster = rosterResult.hasValidRoster;
      item.failReason = rosterResult.failReason;

      // Save to cache (fire-and-forget)
      RosterCache.findOneAndUpdate(
        { name: item.name },
        {
          name: item.name,
          hasRoster: rosterResult.hasValidRoster,
          allCharacters: rosterResult.allCharacters || [],
          failReason: rosterResult.failReason || '',
          cachedAt: new Date(),
        },
        { upsert: true, returnDocument: 'after' }
      ).catch((err) => console.warn(`[listcheck] Cache save failed for ${item.name}:`, err.message));

      // Delay between lostark.bible requests to avoid 429
      await new Promise((r) => setTimeout(r, 500));
    }

    // Search for similar names when no roster found (e.g. diacritics mismatch)
    // Cache stores candidate names only (no flags) — flags recomputed per-request for scope safety
    if (!item.hasRoster) {
      try {
        // Load candidate names from cache or fetch fresh
        let candidateNames = cached?.searchSuggestions?.length > 0
          ? cached.searchSuggestions.map((s) => s.name)
          : null;

        if (!candidateNames) {
          const suggestions = await fetchNameSuggestions(item.name);
          const similarCandidates = suggestions
            .filter((s) => Number(s.itemLevel || 0) >= 1700 && s.name.toLowerCase() !== item.name.toLowerCase())
            .slice(0, 3);
          candidateNames = similarCandidates.map((s) => s.name);

          // Cache candidate names only (flags are scope-dependent, not cacheable)
          if (candidateNames.length > 0) {
            RosterCache.findOneAndUpdate(
              { name: item.name },
              { $set: { searchSuggestions: candidateNames.map((n) => ({ name: n, flag: '' })) } },
            ).catch(() => {});
          }
        }

        if (candidateNames.length > 0) {
          // Compute flags per-request (scope-aware for blacklist)
          const simNames = candidateNames;
          const simQuery = { $or: [{ name: { $in: simNames } }, { allCharacters: { $in: simNames } }] };
          const simBlackQuery = {
            $and: [
              simQuery,
              { $or: [
                { scope: 'global' },
                { scope: { $exists: false } },
                ...(guildId ? [{ scope: 'server', guildId }] : []),
              ] },
            ],
          };
          const [simBlack, simWhite, simWatch] = await Promise.all([
            Blacklist.find(simBlackQuery).collation(collation).lean(),
            Whitelist.find(simQuery).collation(collation).lean(),
            Watchlist.find(simQuery).collation(collation).lean(),
          ]);

          const simBlackMap = buildEntryMap(simBlack);
          const simWhiteMap = buildEntryMap(simWhite);
          const simWatchMap = buildEntryMap(simWatch);

          item.similarNames = candidateNames.map((name) => {
            const lower = name.toLowerCase();
            let flag = '';
            if (simBlackMap.has(lower)) flag += '⛔';
            if (simWhiteMap.has(lower)) flag += '✅';
            if (simWatchMap.has(lower)) flag += '⚠️';
            if (!flag) flag = '❓';
            return { name, flag };
          });
        }
      } catch (err) {
        console.warn(`[listcheck] Similar name search failed for ${item.name}:`, err.message);
      }
    }
  }

  return results;
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a single check result into a display line.
 * @param {object} item
 * @returns {{ line: string, priority: number }}
 */
function formatResultLine(item) {
  const isBlack = Boolean(item.blackEntry);
  const isWhite = Boolean(item.whiteEntry);
  const isWatch = Boolean(item.watchEntry);

  const reasonParts = [];
  for (const [entry] of [[item.blackEntry], [item.whiteEntry], [item.watchEntry]]) {
    if (!entry) continue;
    const isRosterMatch = entry.name.toLowerCase() !== item.name.toLowerCase();
    const details = [];
    if (isRosterMatch) details.push(`via **${entry.name}**`);
    if (entry.reason?.trim()) details.push(entry.reason.trim());
    if (entry.raid?.trim()) details.push(`[${entry.raid.trim()}]`);
    if (details.length > 0) reasonParts.push(details.join(' — '));
  }

  const reasonSuffix = reasonParts.length > 0 ? ` — ${reasonParts.join(' | ')}` : '';

  if (isBlack) {
    const scopeTag = item.blackEntry?.scope === 'server' ? ' `[S]`' : '';
    return { line: `⛔ **${item.name}**${scopeTag}${reasonSuffix}`, priority: 0 };
  }
  if (isWatch) {
    return { line: `⚠️ **${item.name}**${reasonSuffix}`, priority: 1 };
  }
  if (isWhite) {
    return { line: `✅ **${item.name}**${reasonSuffix}`, priority: 2 };
  }
  if (item.hasRoster) {
    return { line: `❓ ${item.name}`, priority: 3 };
  }

  const reason = item.failReason ? ` *(${item.failReason})*` : '';
  const similar = item.similarNames?.length > 0
    ? ` — Similar: ${item.similarNames.map((s) => `${s.flag} ${s.name}`).join(', ')}`
    : '';
  return { line: `⚪ ${item.name}${reason}${similar}`, priority: 4 };
}

/**
 * Format check results into Discord-ready text lines.
 * Sorted by priority: ⛔ flagged first, then ⚠️ watch, ✅ white, ❓ clean, ⚪ no roster.
 * Includes a summary header line.
 *
 * @param {Array<object>} results - Output from checkNamesAgainstLists
 * @returns {string[]} Formatted lines including summary
 */
export function formatCheckResults(results) {
  const formatted = results.map((item) => ({ ...formatResultLine(item), item }));

  // Sort by priority: flagged first
  formatted.sort((a, b) => a.priority - b.priority);

  // Count by category
  const counts = { black: 0, watch: 0, white: 0, clean: 0, noRoster: 0 };
  for (const f of formatted) {
    if (f.priority === 0) counts.black++;
    else if (f.priority === 1) counts.watch++;
    else if (f.priority === 2) counts.white++;
    else if (f.priority === 3) counts.clean++;
    else counts.noRoster++;
  }

  // Build summary
  const summaryParts = [];
  if (counts.black) summaryParts.push(`⛔ ${counts.black}`);
  if (counts.watch) summaryParts.push(`⚠️ ${counts.watch}`);
  if (counts.white) summaryParts.push(`✅ ${counts.white}`);
  if (counts.clean) summaryParts.push(`❓ ${counts.clean}`);
  if (counts.noRoster) summaryParts.push(`⚪ ${counts.noRoster}`);

  const lines = [];

  // Only show summary when there are flagged entries — otherwise it's just noise
  const hasFlagged = counts.black > 0 || counts.watch > 0;
  if (hasFlagged) {
    lines.push(summaryParts.join(' · '));
    lines.push('');
  }

  for (const f of formatted) {
    lines.push(f.line);
  }

  return lines;
}
