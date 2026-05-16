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
  'Ignore other text: raid names, item levels, buttons, chat messages, server/world names (e.g. Vairgrys, Brelshaza, Thaemine).',
  'For each character, identify the class from the small class icon shown to the left of the name. Use the official English class display name from Lost Ark: Berserker, Slayer, Gunlancer, Paladin, Valkyrie, Destroyer, Guardian Knight, Wardancer, Scrapper, Soulfist, Glaivier, Striker, Breaker, Deadeye, Gunslinger, Artillerist, Sharpshooter, Machinist, Bard, Arcanist, Summoner, Sorceress, Deathblade, Shadow Hunter, Reaper, Souleater, Artist, Aeromancer, Wildsoul.',
  'If the class icon is unreadable or you cannot identify it confidently, use an empty string for class instead of guessing.',
  'Preserve every character name exactly as shown, including special letters and diacritics.',
  'Lost Ark names frequently use diacritics: ë, ï, ö, ü, í, é, â, î. Pay close attention to dots/marks above letters.',
  'Keep umlaut letters exactly: ë, ö, ü.',
  'Do NOT convert umlauts to grave-accent letters: ë!=è, ö!=ò, ü!=ù.',
  'If a mark looks like two horizontal dots above a letter, treat it as an umlaut on that letter, not as punctuation.',
  'Return JSON array of objects only, no markdown, no explanation.',
  'Each object has two keys: "name" (string) and "class" (string).',
  'Example output: [{"name":"PlayerOne","class":"Bard"},{"name":"PlayerTwo","class":"Berserker"}].',
  'If a class cannot be identified, return an empty string for that entry\'s class field, e.g. {"name":"PlayerThree","class":""}.',
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

/**
 * Normalize a single Gemini output item into `{ name, ocrClass }`. Accepts
 * both shapes for forward/backward compatibility:
 *   - Legacy: bare string `"PlayerOne"` → no class info.
 *   - Current: object `{name, class}` → class carried through when present.
 * Returns null when the input can't yield a usable name.
 */
function normalizeOcrEntry(item) {
  if (typeof item === 'string') {
    const name = normalizeCharacterName(item);
    return name ? { name, ocrClass: '' } : null;
  }
  if (item && typeof item === 'object') {
    const name = normalizeCharacterName(item.name || '');
    if (!name) return null;
    const ocrClass = typeof item.class === 'string' ? item.class.trim() : '';
    return { name, ocrClass };
  }
  return null;
}

function filterAndDeduplicateEntries(parsed) {
  const entries = parsed
    .map(normalizeOcrEntry)
    .filter((entry) => entry && !SERVER_NAMES.has(entry.name.toLowerCase()));

  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

/**
 * Extract character names + classes from an image using Gemini OCR.
 * Handles model failover on quota/rate limits and network errors.
 *
 * Class info is best-effort: Gemini reads the small class icon next to
 * each name in the raid lobby image. Used as a fallback when the bot
 * has no RosterSnapshot and the worker-backed meta probe is offline, so
 * class icons render even on a cold OCR check. Empty string when Gemini
 * cannot identify the class confidently.
 *
 * @param {object} image - Discord attachment or { url, contentType }
 * @returns {Promise<Array<{name: string, ocrClass: string}>>} OCR entries
 */
export async function extractNamesFromImage(image) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (image.contentType && !image.contentType.startsWith('image/')) {
    throw new Error('Attachment must be an image file.');
  }

  const cacheKey = image.url || '';
  const cachedEntries = getCachedOcrNames(cacheKey);
  if (cachedEntries !== undefined) {
    console.log(`[listcheck] OCR cache hit for attachment ${image.id || cacheKey.slice(0, 32)}`);
    return cachedEntries;
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

    const entries = filterAndDeduplicateEntries(parsed);
    setCachedOcrNames(cacheKey, entries);
    return entries;
  }

  throw new Error(`All Gemini models failed: ${failures.join(' | ')}`);
}

// ─── Name checking ──────────────────────────────────────────────────────────

/**
 * Check OCR entries against database-backed lists.
 *
 * Accepts either the legacy bare-name shape (`string[]`) or the new
 * Gemini-extracted shape (`Array<{name, ocrClass}>`). Both flow through
 * the same DB + targeted-enrichment pipeline; the `ocrClass` field, when
 * present, is propagated into the result as a class-icon fallback when
 * neither the snapshot nor the worker-backed meta probe provides class
 * info (e.g. worker offline + never-queried name).
 *
 * @param {Array<string | {name: string, ocrClass?: string, class?: string}>} entries
 * @param {object} [options]
 * @param {string} [options.guildId] - Guild ID for including server-scoped blacklist entries
 * @returns {Promise<Array<object>>} Results with list entries + snapshot + ocr metadata
 */
export async function checkNamesAgainstLists(entries, options = {}) {
  const startedAt = Date.now();
  await connectDB();
  const { guildId } = options;

  // Normalize the caller's input into a uniform { name, ocrClass } shape.
  // Legacy callers passing bare strings still work; new callers benefit
  // from the carried ocrClass propagation.
  const normalized = (entries || [])
    .map((item) => {
      if (typeof item === 'string') return { name: item, ocrClass: '' };
      if (item && typeof item === 'object' && item.name) {
        return { name: item.name, ocrClass: item.ocrClass || item.class || '' };
      }
      return null;
    })
    .filter(Boolean);

  const names = normalized.map((n) => n.name);
  const ocrClassByName = new Map(
    normalized
      .filter((n) => n.ocrClass)
      .map((n) => [n.name.toLowerCase(), n.ocrClass])
  );

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
      // OCR-detected class (best-effort from Gemini reading the raid
      // lobby icon). Used as a fallback by format.js when neither the
      // snapshot nor the worker meta probe filled snapClassName.
      // Empty string when Gemini wasn't confident or the input came
      // through the legacy string[] entry shape.
      ocrClassName: ocrClassByName.get(name.toLowerCase()) || '',
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
    // Worker-health gate: when the residential-IP worker is offline, every
    // per-name probe would fail at the worker layer ("Stronghold lookup
    // service is offline (stale-heartbeat)") and spam logs while adding
    // 400-600ms of wasted latency. Skip the whole enrichment phase up
    // front instead, log once, and fall back to the bare render that the
    // prior DB-only refactor already supports gracefully. Feature
    // self-reactivates the next time a check runs after the worker is
    // started.
    const health = await getWorkerHealth().catch(() => ({ online: false, reason: 'health-check-threw' }));

    if (!health.online) {
      console.log(
        `[listcheck] Skipping meta enrichment for ${itemsNeedingEnrichment.length} name(s) ` +
        `(worker offline: ${health.reason || 'unknown'}). Names render without class/ilvl.`
      );
    } else {
    const concurrency = config.listcheckRosterLookupConcurrency || 3;
    const lookupTimeoutMs = config.listcheckRosterLookupTimeoutMs || 6000;
    const enrichStartedAt = Date.now();

    await mapWithConcurrency(itemsNeedingEnrichment, concurrency, async (item) => {
      try {
        const meta = await fetchCharacterMeta(item.name, {
          viaWorker: true,
          retryOnRateLimit: false,
          timeoutMs: lookupTimeoutMs,
        });
        if (!meta) return;
        if (meta.classId) {
          item.snapClassId = meta.classId;
          item.snapClassName = getClassName(meta.classId);
        }
        if (typeof meta.itemLevel === 'number' && meta.itemLevel > 0) {
          item.snapItemLevel = meta.itemLevel;
        }
        // Best-effort snapshot upsert so the next OCR run sees the data
        // without re-calling bible. Failure is non-fatal · the in-memory
        // enrichment still renders for THIS call.
        try {
          await RosterSnapshot.updateOne(
            { name: item.name },
            {
              $set: {
                itemLevel: meta.itemLevel || 0,
                classId: meta.classId || '',
                rosterName: item.name,
                updatedAt: new Date(),
              },
            },
            { upsert: true, collation: { locale: 'en', strength: 2 } }
          );
        } catch (saveErr) {
          console.warn(`[listcheck] Snapshot upsert failed for ${item.name}: ${saveErr.message}`);
        }
      } catch (err) {
        // Per-name failure is non-fatal: leave snap fields empty so the
        // formatter renders the bare name. Worker-offline / 403 / rate
        // limit / timeout all land here.
        console.warn(`[listcheck] Meta enrichment skipped for ${item.name}: ${err.message}`);
      }
    });

    console.log(
      `[listcheck] Meta-enriched ${itemsNeedingEnrichment.length} name(s) in ${Date.now() - enrichStartedAt}ms (cost: API per missing-snapshot name)`
    );
    }
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
