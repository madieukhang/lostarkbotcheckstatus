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
import { fetchNameSuggestions } from '../roster/search.js';
import { buildRosterCharacters } from '../roster/buildRosterCharacters.js';
import { resolveClassId } from '../../models/Class.js';
import { getWorkerHealth } from '../worker/heartbeat.js';
import { mapWithConcurrency } from '../../utils/async.js';

const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Canonicalise a name for diacritic-tolerant comparison. Strips
 * combining marks (NFD decomposition + drop ̀-ͯ) and
 * lowercases. Used when bible search returns a canonical candidate
 * for a name where Gemini OCR added, dropped, or swapped a mark.
 */
function stripDiacritics(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Aggressive ASCII fallback for bible search retries. Strips combining
// marks AND any remaining non-ASCII codepoint (catches Cyrillic
// look-alikes and other Unicode confusables that survive Gemini's OCR
// + normalizeCharacterName). Bible's search index is diacritic-
// tolerant on the server side, so a pure-ASCII query like
// "banhcanhcua" still returns the canonical "B\u00e1nhcanhc\u00fca". Empty
// string is returned when nothing ASCII survives, in which case the
// caller skips the retry.
function asciiFoldName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .toLowerCase();
}

function visualNameKey(value) {
  return stripDiacritics(value)
    .replace(/[l1]/g, 'i')
    .replace(/0/g, 'o');
}

/**
 * Levenshtein edit distance · O(m·n) DP with rolling rows. Returns the
 * minimum number of single-character insertions / deletions / swaps to
 * turn `a` into `b`. Used to recover from Gemini OCR mistakes like
 * doubled letters ("Trùmffighter" vs "Trùmfighter" → distance 1) when
 * an exact / diacritic-tolerant match against bible's search results
 * doesn't land.
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    const curr = new Array(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

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
  'Letter count must match the image exactly. Do NOT double letters that appear once (e.g., a name shown as "Trumfighter" must not be returned as "Trumffighter"). Do NOT collapse repeated letters that appear twice.',
  'Lost Ark character names do not contain spaces; if letters appear as one character name, return them as one continuous string.',
  'Look-alike characters: distinguish lowercase L (l), uppercase i (I), and digit 1 (1) by context. Distinguish digit 0 (0) from uppercase O (O).',
  'Lowercase letter pairs that lobby fonts can blur are NOT interchangeable: a vs e, a vs o, c vs e, u vs v, rn vs m. Pick the letter whose silhouette actually matches the pixel cluster · a has a closed bowl, e has a horizontal crossbar, o is fully round.',
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

function chooseCanonicalSuggestion(name, suggestions) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return null;

  // First pass: case-insensitive exact match. Covers the happy path
  // where Gemini preserved every character but casing drifted.
  const target = String(name).toLowerCase();
  let chosen = suggestions.find((s) => String(s.name).toLowerCase() === target);
  if (chosen) return { chosen, reason: 'exact' };

  // Second pass: diacritic-tolerant match. Gemini sometimes adds,
  // drops, or swaps marks; bible's search can still return the real
  // canonical name as a nearby candidate.
  const targetCanonical = stripDiacritics(name);
  chosen = suggestions.find(
    (s) => stripDiacritics(String(s.name)) === targetCanonical
  );
  if (chosen) return { chosen, reason: 'diacritic' };

  // Third pass: targeted visual look-alike match for short names where
  // a full edit-distance pass would be too loose.
  const targetVisual = visualNameKey(name);
  if (targetVisual !== targetCanonical) {
    chosen = suggestions.find((s) => visualNameKey(String(s.name)) === targetVisual);
    if (chosen) return { chosen, reason: 'lookalike' };
  }

  // Fourth pass: edit-distance fuzzy match. Recovers small OCR errors
  // beyond accents: doubled/missing letters and other substitutions.
  if (targetCanonical.length < 6) return null;
  const maxDistance = Math.min(2, Math.floor(targetCanonical.length / 6));
  let bestMatch = null;
  let bestDistance = Infinity;
  for (const s of suggestions) {
    const dist = levenshteinDistance(
      targetCanonical,
      stripDiacritics(String(s.name))
    );
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatch = s;
    }
  }

  if (bestMatch && bestDistance <= maxDistance) {
    return { chosen: bestMatch, reason: 'fuzzy', distance: bestDistance, maxDistance };
  }
  return null;
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
 *   - Worker online  → `buildRosterCharacters` via worker. Single
 *     bible roster-page scrape returns class + ilvl + CP for the
 *     target AND the full alt list. Result populates the snapshot
 *     plus `item.discoveredAlts` so the formatter can render alts
 *     for OCR'd names with no DB hit.
 *   - Worker offline → `fetchNameSuggestions` direct from Railway
 *     (lightweight search endpoint, less aggressive CF protection
 *     than the per-character page route). Class + ilvl only; alts
 *     are not available in this mode.
 * Both paths persist class + ilvl to RosterSnapshot so subsequent
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
      // Roster alts discovered during the online enrichment branch
      // (worker-online + visible roster). DB list entries already carry
      // their own allCharacters; this field surfaces alts for OCR'd
      // names that have no DB hit yet, so format.js can render them
      // inline. Empty when worker offline, hidden roster, or the name
      // is not on bible.
      discoveredAlts: [],
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

    async function applyEnrichment(item, { classId, itemLevel, combatScore }) {
      if (classId) {
        item.snapClassId = classId;
        item.snapClassName = getClassName(classId);
      }
      if (typeof itemLevel === 'number' && itemLevel > 0) {
        item.snapItemLevel = itemLevel;
      }
      if (combatScore && combatScore !== '?') {
        item.snapCombatScore = String(combatScore);
      }
      try {
        const setOps = {
          itemLevel: itemLevel || 0,
          classId: classId || '',
          rosterName: item.name,
          updatedAt: new Date(),
        };
        if (combatScore && combatScore !== '?') {
          setOps.combatScore = String(combatScore);
        }
        await RosterSnapshot.updateOne(
          { name: item.name },
          { $set: setOps },
          { upsert: true, collation: { locale: 'en', strength: 2 } }
        );
      } catch (saveErr) {
        // Snapshot upsert failure is non-fatal · in-memory enrichment
        // still renders for THIS call; next call just re-fetches.
        console.warn(`[listcheck] Snapshot upsert failed for ${item.name}: ${saveErr.message}`);
      }
    }

    async function applySearchSuggestionEnrichment(item) {
      const originalName = item.name;
      let suggestions = await fetchNameSuggestions(originalName);
      // Bible search returns empty `[[]]` when the query bytes do not
      // match its index (observed for NFD-form input and visually-
      // confusable Unicode like Cyrillic look-alikes that survive
      // normalizeCharacterName + the OCR prompt's diacritic guard).
      // Retry once with an ASCII-folded query. Bible's search is
      // diacritic-tolerant server-side, so "banhcanhcua" still returns
      // the canonical "Bánhcanhcüa" row that the 4-pass canonical
      // matcher below can then snap onto.
      if (!suggestions || suggestions.length === 0) {
        const folded = asciiFoldName(originalName);
        if (folded && folded !== originalName.toLowerCase()) {
          console.log(
            `[listcheck] Search empty for "${originalName}", retrying with ASCII fold "${folded}"`
          );
          suggestions = await fetchNameSuggestions(folded);
        }
      }
      const match = chooseCanonicalSuggestion(originalName, suggestions);
      if (!match) return false;

      const { chosen, reason, distance, maxDistance } = match;
      const chosenName = normalizeCharacterName(chosen.name);
      if (!chosenName) return false;

      if (chosenName !== originalName) {
        if (reason === 'diacritic') {
          console.log(
            `[listcheck] Diacritic-tolerant match: OCR'd "${originalName}" -> canonical "${chosenName}"`
          );
        } else if (reason === 'fuzzy') {
          console.log(
            `[listcheck] Fuzzy match (edit dist ${distance} <= ${maxDistance}): OCR'd "${originalName}" -> canonical "${chosenName}"`
          );
        } else if (reason === 'lookalike') {
          console.log(
            `[listcheck] Look-alike match: OCR'd "${originalName}" -> canonical "${chosenName}"`
          );
        } else {
          console.log(
            `[listcheck] Search canonical match: OCR'd "${originalName}" -> canonical "${chosenName}"`
          );
        }
        item.name = chosenName;
      }

      await applyEnrichment(item, {
        classId: chosen.cls || '',
        itemLevel: Number(chosen.itemLevel) || 0,
      });
      return true;
    }

    await mapWithConcurrency(itemsNeedingEnrichment, concurrency, async (item) => {
      try {
        if (health.online) {
          // Case 1 · worker online: scrape the roster page via worker.
          // Returns class + ilvl + CP for the target AND the full alt
          // list (allCharacters) in a single fetch. The expensive
          // hidden-roster + Stronghold-scan fallback inside the
          // builder is left disabled (default off) to keep the
          // list-check fast path bounded.
          //
          // Worker errors fall through to search-direct rather than
          // bare-render the row. Worker timeouts, parse failures, and
          // transient CF blocks otherwise dead-end here even though
          // bible's lightweight search endpoint can still answer the
          // lookup. Observed for OCR'd names with umlaut characters
          // (e.g. "Banhcanhcua") where the roster-page route is
          // flakier than the search route.
          let roster = null;
          try {
            roster = await buildRosterCharacters(item.name, {
              viaWorker: true,
              retryOnRateLimit: false,
              timeoutMs: lookupTimeoutMs,
            });
          } catch (workerErr) {
            console.warn(
              `[listcheck] Worker enrichment threw for ${item.name}, falling back to search-direct: ${workerErr.message}`
            );
          }
          if (!roster || !roster.hasValidRoster) {
            await applySearchSuggestionEnrichment(item);
            return;
          }
          // Resolve classId from the per-character record (parser gives
          // us classId directly), falling back to resolveClassId on the
          // display name when the record didn't surface a bible id.
          const targetRecord = (roster.rosterCharacters || []).find(
            (c) => String(c.name).toLowerCase() === item.name.toLowerCase()
          );
          const classId = targetRecord?.classId
            || (roster.targetClassName ? resolveClassId(roster.targetClassName) : '')
            || '';
          const rosterItemLevel = typeof roster.targetItemLevel === 'number' ? roster.targetItemLevel : 0;
          if (!classId && !rosterItemLevel) {
            await applySearchSuggestionEnrichment(item);
            return;
          }
          await applyEnrichment(item, {
            classId,
            itemLevel: rosterItemLevel,
            combatScore: roster.targetCombatScore || targetRecord?.combatScore || '',
          });
          // Roster alts surface only when the roster is publicly visible.
          // Hidden / missing rosters skip silently per the user-facing
          // "if hidden, just don't count" contract.
          if (roster.rosterVisibility === 'visible' && Array.isArray(roster.allCharacters)) {
            item.discoveredAlts = roster.allCharacters.filter(
              (n) => String(n).toLowerCase() !== item.name.toLowerCase()
            );
          }
        } else {
          // Case 2: worker offline; use bible search directly.
          await applySearchSuggestionEnrichment(item);
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

  // Phase 2: Resolve trusted status via roster relationships.
  //
  // Two alt sources cross-reference into TrustedUser here:
  //   (a) `allCharacters` already stored on a blacklist / whitelist /
  //       watchlist entry that the OCR'd name hit. These alts were
  //       captured during the original /la-list add bible scrape.
  //   (b) `item.discoveredAlts` populated by the worker-online
  //       enrichment branch above (single roster-page scrape returns
  //       the OCR'd name's full alt list). This covers the case where
  //       a char has NO direct DB list hit but its bible roster shares
  //       a main with a trusted entry · e.g. Morrahduk lives on
  //       Clauseduk's roster and Clauseduk is trusted, so Morrahduk
  //       inherits trust via the alts the roster scrape just returned.
  //
  // OCR checks still avoid an extra roster fetch here · we reuse the
  // alts the gather phase already paid for.
  const altNamesForTrustedCheck = new Set();
  for (const item of results) {
    if (item.trustedEntry) continue;
    for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
      if (!entry?.allCharacters) continue;
      for (const c of entry.allCharacters) altNamesForTrustedCheck.add(c);
    }
    if (Array.isArray(item.discoveredAlts)) {
      for (const c of item.discoveredAlts) altNamesForTrustedCheck.add(c);
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
        if (!item.trustedEntry && Array.isArray(item.discoveredAlts)) {
          for (const c of item.discoveredAlts) {
            const match = altTrustedSet.get(c.toLowerCase());
            if (match) { item.trustedEntry = match; break; }
          }
        }
      }
    }
  }

  console.log(
    `[listcheck] Checked ${names.length} name(s) in ${Date.now() - startedAt}ms (db-only)`
  );
  return results;
}
