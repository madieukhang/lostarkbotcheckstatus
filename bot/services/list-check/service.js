/**
 * services/list-check/service.js
 * Shared logic for checking character names against blacklist/whitelist/watchlist.
 * Used by both /la-check command and auto-check channel handler.
 */

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
import { normalizeCharacterName } from '../../utils/names.js';
export { formatCheckResults } from './format.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { fetchCharacterMeta } from '../roster/characterMeta.js';
import { fetchNameSuggestions } from '../roster/search.js';
import { getWorkerHealth } from '../worker/heartbeat.js';
import { mapWithConcurrency } from '../../utils/async.js';

const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;

// ─── Constants ──────────────────────────────────────────────────────────────

/** Known Lost Ark server/world names to filter from OCR results */
const SERVER_NAMES = new Set([
  'azena', 'avesta', 'galatur', 'karta', 'ladon', 'kharmine',
  'una', 'regulus', 'sasha', 'vykas', 'elgacia', 'thaemine',
  'brelshaza', 'kazeros', 'arcturus', 'enviska', 'valtan', 'mari',
  'akkan', 'vairgrys', 'bergstrom', 'danube', 'mokoko',
]);

const ocrCache = new Map();

function getCachedOcrNames(cacheKey) {
  if (!cacheKey) return undefined;
  const entry = ocrCache.get(cacheKey);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    ocrCache.delete(cacheKey);
    return undefined;
  }
  ocrCache.delete(cacheKey);
  ocrCache.set(cacheKey, entry);
  return [...entry.names];
}

function setCachedOcrNames(cacheKey, names) {
  if (!cacheKey || !Array.isArray(names)) return;
  if (ocrCache.size >= config.ocrCacheMaxSize) {
    const firstKey = ocrCache.keys().next().value;
    ocrCache.delete(firstKey);
  }
  ocrCache.set(cacheKey, {
    names: [...names],
    expiresAt: Date.now() + config.ocrCacheTtlMs,
  });
}

export function clearOcrCache() {
  ocrCache.clear();
}

/** Gemini OCR prompt for Lost Ark waiting room screenshots */
const GEMINI_PROMPT = [
  'This is a screenshot of a Lost Ark raid waiting room (party finder lobby).',
  'Extract ALL player character names from the party member list, regardless of color.',
  'Ignore all other text: raid names, class names, item levels, buttons, chat messages, server/world names (e.g. Vairgrys, Brelshaza, Thaemine).',
  'Preserve every character exactly as shown, including special letters and diacritics.',
  'Lost Ark names frequently use diacritics: ë, ï, ö, ü, í, é, â, î. Pay close attention to dots/marks above letters.',
  'Keep umlaut letters exactly: ë, ö, ü.',
  'Do NOT convert umlauts to grave-accent letters: ë!=è, ö!=ò, ü!=ù.',
  'If a mark looks like two horizontal dots above a letter, treat it as an umlaut on that letter, not as punctuation.',
  'Return JSON array only, no markdown, no explanation.',
  'Example output: ["name1","name2"].',
  'If no valid names are found, return [].',
].join(' ');

// ─── Gemini OCR ─────────────────────────────────────────────────────────────

function shouldFailoverGeminiModel(status, bodyText) {
  // 404 = model not found, 429 = rate limit, 503 = overloaded · all should try next model
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

  const cacheKey = image.url || '';
  const cachedNames = getCachedOcrNames(cacheKey);
  if (cachedNames !== undefined) {
    console.log(`[listcheck] OCR cache hit for attachment ${image.id || cacheKey.slice(0, 32)}`);
    return cachedNames;
  }

  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  if (!imageRes.ok) {
    throw new Error(`Failed to download attachment (HTTP ${imageRes.status})`);
  }

  const contentLength = imageRes.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_OCR_IMAGE_BYTES) {
    throw new Error('Image file too large (max 20MB).');
  }

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  if (imageBuffer.byteLength > MAX_OCR_IMAGE_BYTES) {
    throw new Error('Image file too large (max 20MB).');
  }
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

    // Filter out thinking parts (thought: true) · only keep actual response text
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

    const names = filterAndDeduplicateNames(parsed);
    setCachedOcrNames(cacheKey, names);
    return names;
  }

  throw new Error(`All Gemini models failed: ${failures.join(' | ')}`);
}

// ─── Name checking ──────────────────────────────────────────────────────────

/**
 * Check an array of names against database-backed lists.
 *
 * After DB cross-check, items missing class+ilvl snapshot data go
 * through a targeted enrichment phase that routes by worker health:
 *   - Worker online  → `fetchCharacterMeta` via worker (full meta).
 *   - Worker offline → `fetchNameSuggestions` direct from Railway
 *     (lightweight search endpoint, less aggressive CF protection
 *     than the per-character page route).
 * Both paths persist the result to RosterSnapshot so subsequent
 * checks on the same name hit the cache for free.
 *
 * @param {string[]} names
 * @param {object} [options]
 * @param {string} [options.guildId] - Guild ID for including server-scoped blacklist entries
 * @returns {Promise<Array<object>>} Results with list entries and stored snapshot metadata
 */
export async function checkNamesAgainstLists(names, options = {}) {
  const startedAt = Date.now();
  await connectDB();
  const { guildId } = options;

  // Phase 1: Batch list check · 3 queries for ALL names instead of 3 × N
  const nameQuery = { $or: [{ name: { $in: names } }, { allCharacters: { $in: names } }] };
  const collation = { locale: 'en', strength: 2 };

  // Blacklist: scope-aware query (owner sees all, others see global + own server)
  const blackQuery = buildBlacklistQuery(nameQuery, guildId);

  // RosterSnapshot has class/ilvl/CP populated by /la-roster runs.
  // Best-effort enrichment: names previously queried have rich data
  // surfaced inline; brand-new names render without (graceful fallback).
  // One query for all input names, joined into the results below.
  const [allBlack, allWhite, allWatch, allTrusted, allSnapshots] = await Promise.all([
    Blacklist.find(blackQuery).collation(collation).lean(),
    Whitelist.find(nameQuery).collation(collation).lean(),
    Watchlist.find(nameQuery).collation(collation).lean(),
    TrustedUser.find({ name: { $in: names } }).collation(collation).lean(),
    RosterSnapshot.find({ name: { $in: names } }).collation(collation).lean(),
  ]);
  const snapshotMap = new Map(allSnapshots.map((s) => [s.name.toLowerCase(), s]));

  // Build O(1) lookup maps from list entries (once per list, not per name)
  function buildEntryMap(entries) {
    const map = new Map();
    for (const e of entries) {
      map.set(e.name.toLowerCase(), e);
      for (const c of (e.allCharacters || [])) {
        const lower = c.toLowerCase();
        // Allow overwrite if: key new, or current entry is server-scoped (higher priority)
        if (!map.has(lower) || e.scope === 'server') map.set(lower, e);
      }
    }
    return map;
  }

  // Sort blacklist: global first, server last → server overwrites in map (higher priority)
  allBlack.sort((a, b) => (a.scope === 'server' ? 1 : 0) - (b.scope === 'server' ? 1 : 0));
  const blackMap = buildEntryMap(allBlack);
  const whiteMap = buildEntryMap(allWhite);
  const watchMap = buildEntryMap(allWatch);
  const trustedMap = new Map(allTrusted.map((t) => [t.name.toLowerCase(), t]));

  const results = names.map((name) => {
    const snap = snapshotMap.get(name.toLowerCase()) || null;
    return {
      name,
      blackEntry: blackMap.get(name.toLowerCase()) || null,
      whiteEntry: whiteMap.get(name.toLowerCase()) || null,
      watchEntry: watchMap.get(name.toLowerCase()) || null,
      trustedEntry: trustedMap.get(name.toLowerCase()) || null,
      hasRoster: false,
      failReason: null,
      similarNames: null,
      // Snapshot enrichment: present when /la-roster has previously
      // queried this name. Empty/null when never seen before; render
      // sites fall back gracefully.
      snapClassId: snap?.classId || '',
      snapClassName: snap?.classId ? getClassName(snap.classId) : '',
      snapItemLevel: snap?.itemLevel || 0,
      snapCombatScore: snap?.combatScore || '',
    };
  });

  // Phase 1.5: Targeted meta enrichment for items missing class+ilvl data.
  // Re-introduces a SINGLE-character bible meta lookup (per name) for
  // entries whose stored snapshot is missing or incomplete. Items that
  // already have usable class+ilvl skip the lookup entirely, so the
  // cost is "1 API call per previously-unseen name" rather than "1 per
  // name". Persists the result back to RosterSnapshot so the next OCR
  // run for the same name is free.
  //
  // Boundary with the prior DB-only refactor: still avoid the heavy
  // roster-page scrape, similar-name search, hidden-roster fallback,
  // and Stronghold alt scan. Only the single-name meta probe is
  // restored, and only when there is a real UX gap (no snapshot data).
  // Routed via worker by default to stay off Railway's CF-blocked path.
  const itemsNeedingEnrichment = results.filter(
    (item) => !item.snapClassId || !item.snapItemLevel
  );

  if (itemsNeedingEnrichment.length > 0) {
    // Worker-health gate selects the enrichment route, never silently
    // skips. Two cases:
    //   - Worker ONLINE  → fetchCharacterMeta via worker. Richest data
    //     (class + ilvl + stronghold + guild) on a residential IP that
    //     bible accepts. Result persisted to RosterSnapshot.
    //   - Worker OFFLINE → fetchNameSuggestions direct from Railway.
    //     bible's search endpoint is lighter and tends to slip past CF
    //     where the per-character HTML page does not. Returns just
    //     {name, cls, itemLevel} for matches; we pick the exact-name
    //     row and persist class+ilvl.
    // Both paths upsert the snapshot so the next OCR run hits cache.
    const health = await getWorkerHealth().catch(() => ({ online: false, reason: 'health-check-threw' }));

    const concurrency = config.listcheckRosterLookupConcurrency || 3;
    const lookupTimeoutMs = config.listcheckRosterLookupTimeoutMs || 6000;
    const enrichStartedAt = Date.now();
    const mode = health.online ? 'worker-meta' : 'search-direct';

    async function applyEnrichment(item, { classId, itemLevel }) {
      if (classId) {
        item.snapClassId = classId;
        item.snapClassName = getClassName(classId);
      }
      if (typeof itemLevel === 'number' && itemLevel > 0) {
        item.snapItemLevel = itemLevel;
      }
      try {
        await RosterSnapshot.updateOne(
          { name: item.name },
          {
            $set: {
              itemLevel: itemLevel || 0,
              classId: classId || '',
              rosterName: item.name,
              updatedAt: new Date(),
            },
          },
          { upsert: true, collation: { locale: 'en', strength: 2 } }
        );
      } catch (saveErr) {
        // Snapshot upsert failure is non-fatal · in-memory enrichment
        // still renders for THIS call; next call just re-fetches.
        console.warn(`[listcheck] Snapshot upsert failed for ${item.name}: ${saveErr.message}`);
      }
    }

    await mapWithConcurrency(itemsNeedingEnrichment, concurrency, async (item) => {
      try {
        if (health.online) {
          // Case 1 · worker online: fetch full character meta via worker.
          const meta = await fetchCharacterMeta(item.name, {
            viaWorker: true,
            retryOnRateLimit: false,
            timeoutMs: lookupTimeoutMs,
          });
          if (!meta) return;
          await applyEnrichment(item, {
            classId: meta.classId || '',
            itemLevel: typeof meta.itemLevel === 'number' ? meta.itemLevel : 0,
          });
        } else {
          // Case 2 · worker offline: hit bible's search endpoint directly.
          // No viaWorker (would just fail the same way it failed before).
          const suggestions = await fetchNameSuggestions(item.name);
          if (!Array.isArray(suggestions) || suggestions.length === 0) return;
          const target = item.name.toLowerCase();
          const exact = suggestions.find((s) => String(s.name).toLowerCase() === target);
          if (!exact) return;
          await applyEnrichment(item, {
            classId: exact.cls || '',
            itemLevel: Number(exact.itemLevel) || 0,
          });
        }
      } catch (err) {
        // Per-name failure is non-fatal: leave snap fields empty so the
        // formatter renders the bare name. Network / rate-limit /
        // timeout / search-API-blocked all land here.
        console.warn(`[listcheck] Enrichment (${mode}) skipped for ${item.name}: ${err.message}`);
      }
    });

    console.log(
      `[listcheck] Enriched ${itemsNeedingEnrichment.length} name(s) via ${mode} in ${Date.now() - enrichStartedAt}ms`
    );
  }

  // Phase 2: Resolve trusted status via allCharacters already stored
  // on DB list entries. OCR checks still avoid roster fetch / similar-
  // name search / hidden-roster fallback here.
  const altNamesForTrustedCheck = new Set();
  for (const item of results) {
    if (item.trustedEntry) continue;
    for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
      if (!entry?.allCharacters) continue;
      for (const c of entry.allCharacters) altNamesForTrustedCheck.add(c);
    }
  }

  if (altNamesForTrustedCheck.size > 0) {
    const altTrusted = await TrustedUser.find({ name: { $in: [...altNamesForTrustedCheck] } })
      .collation(collation).lean();

    if (altTrusted.length > 0) {
      const altTrustedSet = new Map(altTrusted.map((t) => [t.name.toLowerCase(), t]));

      for (const item of results) {
        if (item.trustedEntry) continue;
        for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
          if (!entry?.allCharacters) continue;
          for (const c of entry.allCharacters) {
            const match = altTrustedSet.get(c.toLowerCase());
            if (match) { item.trustedEntry = match; break; }
          }
          if (item.trustedEntry) break;
        }
      }
    }
  }

  console.log(
    `[listcheck] Checked ${names.length} name(s) in ${Date.now() - startedAt}ms (db-only)`
  );
  return results;
}
