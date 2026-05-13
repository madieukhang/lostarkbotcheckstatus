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
import RosterCache from '../../models/RosterCache.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName, resolveClassId } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
} from '../roster/index.js';
import { bibleClient } from '../roster/bibleClient.js';
import { getWorkerHealth } from '../worker/heartbeat.js';
import {
  buildRosterCacheLookupMap,
  getRosterCacheMatch,
} from './roster-cache-lookup.js';
import {
  shouldCacheRosterLookupResult,
  shouldRescrapeCachedRoster,
} from './cache-policy.js';
import { isRosterLookupUnavailable } from './roster-status.js';
import { normalizeCharacterName } from '../../utils/names.js';
export {
  shouldCacheRosterLookupResult,
  shouldRescrapeCachedRoster,
} from './cache-policy.js';
export { formatCheckResults } from './format.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { mapWithConcurrency, sleep } from '../../utils/async.js';

const ROSTER_LOOKUP_CONCURRENCY = config.listcheckRosterLookupConcurrency;
const ROSTER_LOOKUP_START_SPACING_MS = config.listcheckRosterLookupStartSpacingMs;
const ROSTER_LOOKUP_TIMEOUT_MS = config.listcheckRosterLookupTimeoutMs;
const SIMILAR_LOOKUP_LIMIT = config.listcheckSimilarLookupLimit;
const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;

async function shouldSkipWorkerRosterLookup() {
  if (!bibleClient.workerEnabled) return false;

  try {
    const health = await getWorkerHealth();
    return health?.online !== true;
  } catch (err) {
    console.warn('[listcheck] Worker health check failed:', err.message);
    return false;
  }
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

  // Phase 2: roster check for ALL names regardless of flag status.
  // Pre-v0.5.72 this branch skipped flagged entries, so blacklisted
  // characters never picked up class/ilvl/CP and rendered as a bare
  // headline. Rendering full character context on flagged rows lets
  // an officer see at a glance whether an OCR'd "RipDead" is the
  // ilvl-1740 main grief or just a same-name cleric · same data
  // backing the unflagged rows already.
  const allCheckedNames = results.map((r) => r.name);

  const cachedEntries = allCheckedNames.length > 0
    ? await RosterCache.find({
        $or: [
          { name: { $in: allCheckedNames } },
          { allCharacters: { $in: allCheckedNames } },
        ],
      }).collation(collation).lean()
    : [];
  const cacheMap = buildRosterCacheLookupMap(cachedEntries);

  const cacheMissItems = [];
  for (const item of results) {

    const cached = getRosterCacheMatch(cacheMap, item.name);

    if (cached) {
      item.hasRoster = cached.hasRoster;
      item.failReason = cached.failReason || null;
      item._allCharacters = cached.allCharacters || [];
      // Surface cached class/ilvl/CP only when the snapshot Phase 1
      // didn't already populate them (snap data takes priority because
      // /la-roster writes more aggressive data than the OCR check).
      // Empty cached fields fall through to the existing snap values.
      if (cached.targetClassName && !item.snapClassName) {
        item.snapClassName = cached.targetClassName;
      }
      if (cached.targetItemLevel > 0 && !(item.snapItemLevel > 0)) {
        item.snapItemLevel = cached.targetItemLevel;
      }
      if (cached.targetCombatScore && !item.snapCombatScore) {
        item.snapCombatScore = cached.targetCombatScore;
      }
      if (cached.searchSuggestions?.length > 0) {
        item.similarNames = cached.searchSuggestions;
        item._cachedSearchSuggestions = cached.searchSuggestions;
      }
      // Force re-scrape when a visible-roster cache row was written by
      // an older bot version that did not store class data. Hidden
      // rosters legitimately lack class data, so their refreshed cache
      // rows opt out via rosterVisibility.
      if (shouldRescrapeCachedRoster(cached)) {
        cacheMissItems.push(item);
        console.log(`[listcheck] Cache hit (missing class data, re-scraping): ${item.name}`);
        continue;
      }
      console.log(`[listcheck] Cache hit: ${item.name} (hasRoster: ${cached.hasRoster})`);
    } else {
      cacheMissItems.push(item);
      continue;
    }
  }

  const skipWorkerRosterLookup = await shouldSkipWorkerRosterLookup();
  let nextLookupStartAt = Date.now();
  async function waitForRosterLookupSlot() {
    const now = Date.now();
    const startAt = Math.max(now, nextLookupStartAt);
    nextLookupStartAt = startAt + ROSTER_LOOKUP_START_SPACING_MS;
    const waitMs = startAt - now;
    if (waitMs > 0) await sleep(waitMs);
  }

  async function attachSimilarNameCandidates(item) {
    try {
      let candidateNames = item._cachedSearchSuggestions?.length > 0
        ? item._cachedSearchSuggestions.map((s) => s.name)
        : null;

      if (!candidateNames) {
        await waitForRosterLookupSlot();
        const suggestions = await fetchNameSuggestions(item.name, {
          allowScraperApi: false,
          fallbackOnRateLimit: false,
          timeoutMs: ROSTER_LOOKUP_TIMEOUT_MS,
          viaWorker: true,
        }) || [];
        const similarCandidates = suggestions
          .filter((s) => Number(s.itemLevel || 0) >= 1700 && s.name.toLowerCase() !== item.name.toLowerCase())
          .slice(0, 3);
        candidateNames = similarCandidates.map((s) => s.name);

        if (candidateNames.length > 0) {
          RosterCache.findOneAndUpdate(
            { name: item.name },
            {
              $set: {
                name: item.name,
                searchSuggestions: candidateNames.map((n) => ({ name: n, flag: '' })),
                cachedAt: new Date(),
              },
            },
            { upsert: true, collation }
          ).catch(() => {});
        }
      }

      item._similarCandidateNames = candidateNames;
    } catch (err) {
      console.warn(`[listcheck] Similar name search failed for ${item.name}:`, err.message);
    }
  }

  await mapWithConcurrency(
    cacheMissItems,
    ROSTER_LOOKUP_CONCURRENCY,
    async (item) => {
      if (skipWorkerRosterLookup) {
        item.rosterLookupSkipped = true;
        return;
      }

      await waitForRosterLookupSlot();
      const rosterStartedAt = Date.now();
      const rosterResult = await buildRosterCharacters(item.name, {
        hiddenRosterFallback: false,
        allowScraperApi: false,
        fallbackOnRateLimit: false,
        retryOnRateLimit: false,
        timeoutMs: ROSTER_LOOKUP_TIMEOUT_MS,
        viaWorker: true,
      });
      item.hasRoster = rosterResult.hasValidRoster;
      item.failReason = rosterResult.failReason;
      item._allCharacters = rosterResult.allCharacters || [];
      // Fresh roster scrape carries the queried character's class +
      // combat score. Surface these so formatResultLine renders the
      // class icon + CP even on the very first /la-list check run for
      // a name (the v0.5.68 RosterSnapshot lookup only had data for
      // names previously queried via /la-roster). Fresh values win
      // over the prior snapshot data set in Phase 1.
      if (rosterResult.targetClassName) {
        item.snapClassName = rosterResult.targetClassName;
      }
      if (typeof rosterResult.targetItemLevel === 'number' && rosterResult.targetItemLevel > 0) {
        item.snapItemLevel = rosterResult.targetItemLevel;
      }
      if (rosterResult.targetCombatScore) {
        item.snapCombatScore = rosterResult.targetCombatScore;
      }
      console.log(
        `[listcheck] Roster lookup: ${item.name} (hasRoster: ${item.hasRoster}) in ${Date.now() - rosterStartedAt}ms`
      );

      if (shouldCacheRosterLookupResult(rosterResult)) {
        try {
          await RosterCache.findOneAndUpdate(
            { name: item.name },
            {
              $set: {
                name: item.name,
                hasRoster: rosterResult.hasValidRoster,
                allCharacters: rosterResult.allCharacters || [],
                failReason: '',
                // Stash the per-target render tokens so the next
                // cache hit can render class icon + CP without a
                // fresh scrape or a snapshot lookup.
                targetClassName: rosterResult.targetClassName || '',
                targetItemLevel: typeof rosterResult.targetItemLevel === 'number'
                  ? rosterResult.targetItemLevel
                  : 0,
                targetCombatScore: rosterResult.targetCombatScore || '',
                rosterVisibility: rosterResult.rosterVisibility || '',
                cachedAt: new Date(),
              },
            },
            { upsert: true, returnDocument: 'after', collation }
          );
        } catch (err) {
          console.warn(`[listcheck] Cache save failed for ${item.name}:`, err.message);
        }
      }

      // Auto-snapshot: when fresh roster data is in hand, write it to
      // RosterSnapshot so the next /la-list check / /la-search hit
      // for this name has the data inline without re-scraping. Same
      // shape as /la-roster's existing snapshot upsert. Best-effort:
      // failures are logged and swallowed so OCR check stays fast.
      // resolveClassId reverse-maps display name -> bible classId (the
      // form RosterSnapshot stores). Falls back to '' when the name
      // isn't in the canonical map (e.g. brand new class Smilegate
      // released and we haven't updated CLASS_NAMES yet).
      const classIdForSnap = rosterResult.targetClassName
        ? (resolveClassId(rosterResult.targetClassName) || '')
        : '';
      if (typeof rosterResult.targetItemLevel === 'number' && rosterResult.targetItemLevel > 0) {
        try {
          await RosterSnapshot.updateOne(
            { name: item.name },
            {
              $set: {
                itemLevel: rosterResult.targetItemLevel,
                classId: classIdForSnap || '',
                combatScore: rosterResult.targetCombatScore || '',
                updatedAt: new Date(),
              },
            },
            { upsert: true, collation }
          );
        } catch (err) {
          console.warn(`[listcheck] Snapshot upsert failed for ${item.name}:`, err.message);
        }
      }
    }
  );

  const noRosterItems = results.filter(
    (item) => !item.blackEntry
      && !item.whiteEntry
      && !item.watchEntry
      && !item.hasRoster
      && !item.rosterLookupSkipped
      && !isRosterLookupUnavailable(item)
  );
  const similarLookupItems = noRosterItems.slice(0, SIMILAR_LOOKUP_LIMIT);
  await mapWithConcurrency(similarLookupItems, ROSTER_LOOKUP_CONCURRENCY, attachSimilarNameCandidates);

  const similarCandidateNames = [];
  const seenSimilarCandidateNames = new Set();
  for (const item of noRosterItems) {
    for (const candidateName of item._similarCandidateNames || []) {
      const normalizedCandidateName = typeof candidateName === 'string' ? candidateName.trim() : '';
      if (!normalizedCandidateName) continue;

      const key = normalizedCandidateName.toLowerCase();
      if (seenSimilarCandidateNames.has(key)) continue;
      seenSimilarCandidateNames.add(key);
      similarCandidateNames.push(normalizedCandidateName);
    }
  }

  if (similarCandidateNames.length > 0) {
    try {
      const simQuery = {
        $or: [
          { name: { $in: similarCandidateNames } },
          { allCharacters: { $in: similarCandidateNames } },
        ],
      };
      const simBlackQuery = buildBlacklistQuery(simQuery, guildId);
      const [simBlack, simWhite, simWatch, simTrusted] = await Promise.all([
        Blacklist.find(simBlackQuery).collation(collation).lean(),
        Whitelist.find(simQuery).collation(collation).lean(),
        Watchlist.find(simQuery).collation(collation).lean(),
        TrustedUser.find({ name: { $in: similarCandidateNames } }).collation(collation).lean(),
      ]);

      const simBlackMap = buildEntryMap(simBlack);
      const simWhiteMap = buildEntryMap(simWhite);
      const simWatchMap = buildEntryMap(simWatch);
      const simTrustedMap = new Map(simTrusted.map((t) => [t.name.toLowerCase(), t]));

      for (const item of noRosterItems) {
        const candidateNames = item._similarCandidateNames || [];
        if (candidateNames.length === 0) continue;

        item.similarNames = candidateNames
          .map((candidateName) => (typeof candidateName === 'string' ? candidateName.trim() : ''))
          .filter(Boolean)
          .map((candidateName) => {
            const lower = candidateName.toLowerCase();
            let flag = '';
            if (simBlackMap.has(lower)) flag += '⛔';
            if (simWhiteMap.has(lower)) flag += '✅';
            if (simWatchMap.has(lower)) flag += '⚠️';
            if (simTrustedMap.has(lower)) flag += '💚';
            if (!flag) flag = '❓';
            return { name: candidateName, flag };
          });
      }
    } catch (err) {
      console.warn('[listcheck] Similar name list cross-check failed:', err.message);
    }
  }

  // Phase 3: Resolve trusted status via allCharacters (alt detection)
  // Collect all roster names from list entries + roster results to check against TrustedUser
  const altNamesForTrustedCheck = new Set();
  for (const item of results) {
    if (item.trustedEntry) continue; // already matched exact
    // From list entries' allCharacters
    for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
      if (entry?.allCharacters) {
        for (const c of entry.allCharacters) altNamesForTrustedCheck.add(c);
      }
    }
    // From roster fetch/cache (stored on item during Phase 2)
    if (item._allCharacters) {
      for (const c of item._allCharacters) altNamesForTrustedCheck.add(c);
    }
  }

  if (altNamesForTrustedCheck.size > 0) {
    const altTrusted = await TrustedUser.find({ name: { $in: [...altNamesForTrustedCheck] } })
      .collation(collation).lean();

    if (altTrusted.length > 0) {
      const altTrustedSet = new Map(altTrusted.map((t) => [t.name.toLowerCase(), t]));

      for (const item of results) {
        if (item.trustedEntry) continue;
        // Check list entry allCharacters
        for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
          if (!entry?.allCharacters) continue;
          for (const c of entry.allCharacters) {
            const match = altTrustedSet.get(c.toLowerCase());
            if (match) { item.trustedEntry = match; break; }
          }
          if (item.trustedEntry) break;
        }
        // Check roster allCharacters (from Phase 2 fetch/cache)
        if (!item.trustedEntry && item._allCharacters) {
          for (const c of item._allCharacters) {
            const match = altTrustedSet.get(c.toLowerCase());
            if (match) { item.trustedEntry = match; break; }
          }
        }
      }
    }
  }

  console.log(
    `[listcheck] Checked ${names.length} name(s) in ${Date.now() - startedAt}ms (cacheMiss=${cacheMissItems.length})`
  );
  return results;
}
