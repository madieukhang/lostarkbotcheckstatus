/**
 * services/list-check/service.js
 * Shared logic for checking character names against blacklist/whitelist/watchlist.
 * Used by both /la-check command and auto-check channel handler.
 */

import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
export { formatCheckResults } from './format.js';
export { clearOcrCache, extractNamesFromImage } from './ocr.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import {
  buildListEntryMap as buildEntryMap,
  buildNameRosterQuery,
  sortBlacklistForScopePriority,
} from '../../utils/listEntryMap.js';
import { applyMarkedSiblingLevelCorrections } from './partyCorrections.js';
import { enrichListCheckResults } from './enrichment.js';

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
  const nameQuery = buildNameRosterQuery(names);
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
    TrustedUser.find(nameQuery).collation(collation).lean(),
    RosterSnapshot.find({ name: { $in: names } }).collation(collation).lean(),
  ]);
  const snapshotMap = new Map(allSnapshots.map((s) => [s.name.toLowerCase(), s]));

  // Build O(1) lookup maps from list entries (once per list, not per name)
  // Sort blacklist: global first, server last → server overwrites in map (higher priority)
  sortBlacklistForScopePriority(allBlack);
  const blackMap = buildEntryMap(allBlack);
  const whiteMap = buildEntryMap(allWhite);
  const watchMap = buildEntryMap(allWatch);
  const trustedMap = buildEntryMap(allTrusted);
  const originalNameSet = new Set(names.map((n) => String(n || '').toLowerCase()));

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

  await applyMarkedSiblingLevelCorrections(results);


  // Phase 1.5: Targeted class/ilvl enrichment lives in its own module so
  // the list-check service stays focused on DB orchestration.
  await enrichListCheckResults(results);

  // Phase 1.6: Enrichment can canonicalize OCR'd names (for example
  // "Auroraforymluv" -> "Auroraformyluv") or discover visible roster
  // siblings. The initial DB list query ran before that data existed,
  // so refresh missing hits against the canonical name + discovered
  // alts before rendering / Quick Add decisions. Without this pass a
  // row can show the right character name but still say "not listed".
  const refreshNames = new Set();
  for (const item of results) {
    const canonical = String(item.name || '').trim();
    if (canonical && !originalNameSet.has(canonical.toLowerCase())) {
      refreshNames.add(canonical);
    }
    for (const alt of (Array.isArray(item.discoveredAlts) ? item.discoveredAlts : [])) {
      const clean = String(alt || '').trim();
      if (clean) refreshNames.add(clean);
    }
  }

  if (refreshNames.size > 0) {
    const refreshList = [...refreshNames];
    const refreshNameQuery = buildNameRosterQuery(refreshList);
    const refreshBlackQuery = buildBlacklistQuery(refreshNameQuery, guildId);
    const [refreshBlack, refreshWhite, refreshWatch, refreshTrusted] = await Promise.all([
      Blacklist.find(refreshBlackQuery).collation(collation).lean(),
      Whitelist.find(refreshNameQuery).collation(collation).lean(),
      Watchlist.find(refreshNameQuery).collation(collation).lean(),
      TrustedUser.find(refreshNameQuery).collation(collation).lean(),
    ]);
    sortBlacklistForScopePriority(refreshBlack);
    const refreshBlackMap = buildEntryMap(refreshBlack);
    const refreshWhiteMap = buildEntryMap(refreshWhite);
    const refreshWatchMap = buildEntryMap(refreshWatch);
    const refreshTrustedMap = buildEntryMap(refreshTrusted);

    function firstMapped(map, candidates) {
      for (const candidate of candidates) {
        const hit = map.get(String(candidate || '').toLowerCase());
        if (hit) return hit;
      }
      return null;
    }

    for (const item of results) {
      const candidates = [
        item.name,
        ...(Array.isArray(item.discoveredAlts) ? item.discoveredAlts : []),
      ].filter(Boolean);
      if (!item.blackEntry) item.blackEntry = firstMapped(refreshBlackMap, candidates);
      if (!item.whiteEntry) item.whiteEntry = firstMapped(refreshWhiteMap, candidates);
      if (!item.watchEntry) item.watchEntry = firstMapped(refreshWatchMap, candidates);
      if (!item.trustedEntry) item.trustedEntry = firstMapped(refreshTrustedMap, candidates);
    }
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
    const trustedNames = [...altNamesForTrustedCheck];
    const altTrusted = await TrustedUser.find(buildNameRosterQuery(trustedNames))
      .collation(collation).lean();

    if (altTrusted.length > 0) {
      const altTrustedSet = buildEntryMap(altTrusted);

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
