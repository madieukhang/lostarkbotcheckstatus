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
  'Extract ONLY the player character names from the party member list.',
  'SKIP the name displayed in yellow/gold color — that is the user\'s own character. Only extract white-colored names.',
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
export async function checkNamesAgainstLists(names) {
  await connectDB();

  // Phase 1: Check all names against lists concurrently (DB queries only — fast)
  const results = await Promise.all(
    names.map(async (name) => {
      const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
        Blacklist.findOne({ $or: [{ name }, { allCharacters: name }] })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Whitelist.findOne({ $or: [{ name }, { allCharacters: name }] })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Watchlist.findOne({ $or: [{ name }, { allCharacters: name }] })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
      ]);

      return { name, blackEntry, whiteEntry, watchEntry, hasRoster: false, failReason: null, similarNames: null };
    })
  );

  // Phase 2: Sequential roster check for unflagged names
  // Check DB cache first → fetch lostark.bible only on cache miss
  for (const item of results) {
    if (item.blackEntry || item.whiteEntry || item.watchEntry) continue;

    // Check roster cache first (avoids repeated HTTP requests for same name)
    const cached = await RosterCache.findOne({ name: item.name })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (cached) {
      item.hasRoster = cached.hasRoster;
      item.failReason = cached.failReason || null;
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
    if (!item.hasRoster) {
      try {
        const suggestions = await fetchNameSuggestions(item.name);
        const similarCandidates = suggestions
          .filter((s) => Number(s.itemLevel || 0) >= 1700 && s.name.toLowerCase() !== item.name.toLowerCase())
          .slice(0, 3);

        if (similarCandidates.length > 0) {
          item.similarNames = await Promise.all(
            similarCandidates.map(async (s) => {
              const [b, w, wa] = await Promise.all([
                Blacklist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
                  .collation({ locale: 'en', strength: 2 }).lean(),
                Whitelist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
                  .collation({ locale: 'en', strength: 2 }).lean(),
                Watchlist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
                  .collation({ locale: 'en', strength: 2 }).lean(),
              ]);
              let flag = '';
              if (b) flag += '⛔';
              if (w) flag += '✅';
              if (wa) flag += '⚠️';
              if (!flag) flag = '❓';
              return { name: s.name, flag };
            })
          );
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
 * Format check results into Discord-ready text lines.
 *
 * @param {Array<object>} results - Output from checkNamesAgainstLists
 * @returns {string[]} Formatted lines
 */
export function formatCheckResults(results) {
  return results.map((item, idx) => {
    const isBlack = Boolean(item.blackEntry);
    const isWhite = Boolean(item.whiteEntry);
    const isWatch = Boolean(item.watchEntry);

    const reasonParts = [];
    for (const [entry, label] of [[item.blackEntry, 'blacklisted'], [item.whiteEntry, 'whitelisted'], [item.watchEntry, 'watchlisted']]) {
      if (!entry) continue;
      const isRosterMatch = entry.name.toLowerCase() !== item.name.toLowerCase();
      const details = [];
      if (isRosterMatch) details.push(`via **${entry.name}**`);
      if (entry.reason?.trim()) details.push(entry.reason.trim());
      if (details.length > 0) reasonParts.push(details.join(' — '));
    }

    const reasonSuffix = reasonParts.length > 0 ? ` — ${reasonParts.join(' | ')}` : '';

    let icon = '';
    if (isBlack) icon += '⛔';
    if (isWhite) icon += '✅';
    if (isWatch) icon += '⚠️';

    if (icon) {
      return `${idx + 1}. ${icon} **${item.name}**${reasonSuffix}`;
    } else if (item.hasRoster) {
      return `${idx + 1}. ❓ **${item.name}**`;
    } else {
      const reason = item.failReason ? ` *(${item.failReason})*` : '';
      const similar = item.similarNames?.length > 0
        ? ` — Similar: ${item.similarNames.map((s) => `${s.flag} ${s.name}`).join(', ')}`
        : '';
      return `${idx + 1}. No roster found: **${item.name}**${reason}${similar}`;
    }
  });
}
