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
import {
  buildListMatchCandidates,
  didListCheckNameChange,
  resolveMappedListMatch,
} from './matchResolution.js';
import { hasDatabaseListMatch } from './verification.js';
export {
  hasDatabaseListMatch,
  isCharacterIdentityVerified,
  partitionListCheckResultsByVerification,
} from './verification.js';

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
 * @param {'ocr'|'text'} [options.inputSource='text'] - How the checked name was supplied
 * @param {Map} [options.suggestionCache] - request-local Bible search cache
 * @param {object} [options.suggestionContext] - request-wide Bible lookup budget and metrics
 * @returns {Promise<Array<object>>} Results with list entries, identity proof,
 *   and stored snapshot metadata
 */
/**
 * Collect the other character names a result row prints - the list entry
 * it matched through and the alts beneath it - and stamp each item with a
 * lowercased name -> className map for those.
 *
 * The searched name already carries snapClassName from the main query;
 * this covers everyone else so a row does not mix icon-led names with
 * bare ones. Missing snapshots are normal (nobody has run /la-roster on
 * that name yet) and simply yield no icon.
 *
 * @param {Array<object>} results - mutated in place
 * @returns {Promise<void>}
 */
async function attachRelatedClassNames(results) {
  const wanted = new Set();
  const relatedFor = (item) => [
    item.blackEntry?.name,
    item.whiteEntry?.name,
    item.watchEntry?.name,
    item.trustedEntry?.name,
    ...(item.blackEntry?.allCharacters || []),
    ...(item.whiteEntry?.allCharacters || []),
    ...(item.watchEntry?.allCharacters || []),
    ...(item.trustedEntry?.allCharacters || []),
    ...(Array.isArray(item.discoveredAlts) ? item.discoveredAlts : []),
  ].map((name) => String(name || '').trim()).filter(Boolean);

  for (const item of results) {
    for (const name of relatedFor(item)) wanted.add(name);
  }
  if (wanted.size === 0) return;

  let snapshots = [];
  try {
    snapshots = await RosterSnapshot.find({ name: { $in: [...wanted] } })
      .collation({ locale: 'en', strength: 2 })
      .lean();
  } catch (err) {
    console.warn('[listcheck] Related-name snapshot lookup failed (non-fatal):', err.message);
    return;
  }

  const classByName = new Map();
  for (const snapshot of snapshots) {
    const className = snapshot?.classId ? getClassName(snapshot.classId) : '';
    if (className) classByName.set(String(snapshot.name).toLowerCase(), className);
  }
  if (classByName.size === 0) return;

  for (const item of results) {
    const related = {};
    for (const name of relatedFor(item)) {
      const className = classByName.get(name.toLowerCase());
      if (className) related[name.toLowerCase()] = className;
    }
    if (Object.keys(related).length > 0) item.relatedClasses = related;
  }
}

export async function checkNamesAgainstLists(names, options = {}) {
  const startedAt = Date.now();
  const connectStartedAt = Date.now();
  await connectDB();
  const connectMs = Date.now() - connectStartedAt;
  const {
    guildId,
    inputSource = 'text',
    suggestionCache,
    suggestionContext,
  } = options;

  // Fetch every input name once per collection. The query count stays
  // constant as the OCR/name batch grows; lookup maps below make the
  // per-name join O(1).
  const nameQuery = buildNameRosterQuery(names);
  const collation = { locale: 'en', strength: 2 };

  // Blacklist: scope-aware query (owner sees all, others see global + own server)
  const blackQuery = buildBlacklistQuery(nameQuery, guildId);

  // (see attachRelatedClassNames below for the entry/alt names)
  // RosterSnapshot has class/ilvl/CP populated by /la-roster runs.
  // Best-effort enrichment: names previously queried have rich data
  // surfaced inline; brand-new names render without (graceful fallback).
  // One query for all input names, joined into the results below.
  const initialDbStartedAt = Date.now();
  const [allBlack, allWhite, allWatch, allTrusted, allSnapshots] = await Promise.all([
    Blacklist.find(blackQuery).collation(collation).lean(),
    Whitelist.find(nameQuery).collation(collation).lean(),
    Watchlist.find(nameQuery).collation(collation).lean(),
    TrustedUser.find(nameQuery).collation(collation).lean(),
    RosterSnapshot.find({ name: { $in: names } }).collation(collation).lean(),
  ]);
  const initialDbMs = Date.now() - initialDbStartedAt;
  const snapshotMap = new Map(allSnapshots.map((s) => [s.name.toLowerCase(), s]));

  // Build O(1) lookup maps from list entries (once per list, not per name)
  // Sort blacklist: global first, server last → server overwrites in map (higher priority)
  sortBlacklistForScopePriority(allBlack);
  const blackMap = buildEntryMap(allBlack);
  const whiteMap = buildEntryMap(allWhite);
  const watchMap = buildEntryMap(allWatch);
  const trustedMap = buildEntryMap(allTrusted);

  const results = names.map((name) => {
    const snap = snapshotMap.get(name.toLowerCase()) || null;
    const candidates = [{ name, origin: 'checked' }];
    const blackMatch = resolveMappedListMatch(blackMap, candidates);
    const whiteMatch = resolveMappedListMatch(whiteMap, candidates);
    const watchMatch = resolveMappedListMatch(watchMap, candidates);
    const trustedMatch = resolveMappedListMatch(trustedMap, candidates);
    const initialListMatch = Boolean(
      blackMatch.entry || whiteMatch.entry || watchMatch.entry || trustedMatch.entry
    );
    return {
      inputName: name,
      inputSource,
      name,
      blackEntry: blackMatch.entry,
      whiteEntry: whiteMatch.entry,
      watchEntry: watchMatch.entry,
      trustedEntry: trustedMatch.entry,
      identityVerified: Boolean(snap || initialListMatch),
      identityVerificationSource: initialListMatch
        ? 'list-database'
        : snap
          ? 'roster-snapshot'
          : null,
      matchDetails: {
        black: blackMatch.detail,
        white: whiteMatch.detail,
        watch: watchMatch.detail,
        trusted: trustedMatch.detail,
      },
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

  // Targeted class/ilvl enrichment lives in its own module so this
  // service stays focused on DB orchestration.
  const enrichmentStartedAt = Date.now();
  const enrichmentOutcome = await enrichListCheckResults(results, {
    suggestionCache,
    suggestionContext,
  });
  const enrichmentTotalMs = Date.now() - enrichmentStartedAt;

  // Enrichment already performs the party-level correction after it has all
  // newly resolved levels. Fully cached batches skip enrichment, so they run
  // the same correction here. This keeps exactly one immutable correction
  // query per request instead of repeating it for mixed cached/uncached input.
  let correctionMs = Number(enrichmentOutcome?.correctionMs) || 0;
  if (!enrichmentOutcome?.correctionApplied) {
    const correctionStartedAt = Date.now();
    await applyMarkedSiblingLevelCorrections(results);
    correctionMs = Date.now() - correctionStartedAt;
  }
  const enrichmentCorrectionMs = Number(enrichmentOutcome?.correctionMs) || 0;
  const enrichmentMs = Math.max(0, enrichmentTotalMs - enrichmentCorrectionMs);

  // Enrichment can canonicalize OCR'd names (for example
  // "Auroraforymluv" -> "Auroraformyluv") or discover visible roster
  // siblings. The initial DB list query ran before that data existed,
  // so reconcile every affected item against its FINAL identity set.
  // Replacement (including null) is intentional: merely filling missing
  // hits would retain a stale match from the pre-correction OCR spelling and
  // could flag a different person.
  const itemsToReconcile = results.filter((item) => (
    didListCheckNameChange(item)
    || (Array.isArray(item.discoveredAlts) && item.discoveredAlts.length > 0)
  ));
  const refreshNames = new Set();
  for (const item of itemsToReconcile) {
    for (const candidate of buildListMatchCandidates(item)) {
      refreshNames.add(candidate.name);
    }
  }

  let refreshDbMs = 0;
  if (refreshNames.size > 0) {
    const refreshList = [...refreshNames];
    const refreshNameQuery = buildNameRosterQuery(refreshList);
    const refreshBlackQuery = buildBlacklistQuery(refreshNameQuery, guildId);
    const refreshDbStartedAt = Date.now();
    const [refreshBlack, refreshWhite, refreshWatch, refreshTrusted] = await Promise.all([
      Blacklist.find(refreshBlackQuery).collation(collation).lean(),
      Whitelist.find(refreshNameQuery).collation(collation).lean(),
      Watchlist.find(refreshNameQuery).collation(collation).lean(),
      TrustedUser.find(refreshNameQuery).collation(collation).lean(),
    ]);
    refreshDbMs = Date.now() - refreshDbStartedAt;
    sortBlacklistForScopePriority(refreshBlack);
    const refreshBlackMap = buildEntryMap(refreshBlack);
    const refreshWhiteMap = buildEntryMap(refreshWhite);
    const refreshWatchMap = buildEntryMap(refreshWatch);
    const refreshTrustedMap = buildEntryMap(refreshTrusted);

    for (const item of itemsToReconcile) {
      const candidates = buildListMatchCandidates(item);
      const blackMatch = resolveMappedListMatch(refreshBlackMap, candidates);
      const whiteMatch = resolveMappedListMatch(refreshWhiteMap, candidates);
      const watchMatch = resolveMappedListMatch(refreshWatchMap, candidates);
      const trustedMatch = resolveMappedListMatch(refreshTrustedMap, candidates);

      item.blackEntry = blackMatch.entry;
      item.whiteEntry = whiteMatch.entry;
      item.watchEntry = watchMatch.entry;
      item.trustedEntry = trustedMatch.entry;
      item.matchDetails.black = blackMatch.detail;
      item.matchDetails.white = whiteMatch.detail;
      item.matchDetails.watch = watchMatch.detail;
      item.matchDetails.trusted = trustedMatch.detail;
    }
  }

  // Resolve trusted status through already-known roster relationships.
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
  // OCR checks avoid another roster fetch by reusing alts from the gather
  // phase.
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

  let trustedDbMs = 0;
  if (altNamesForTrustedCheck.size > 0) {
    const trustedNames = [...altNamesForTrustedCheck];
    const trustedDbStartedAt = Date.now();
    const altTrusted = await TrustedUser.find(buildNameRosterQuery(trustedNames))
      .collation(collation).lean();
    trustedDbMs = Date.now() - trustedDbStartedAt;

    if (altTrusted.length > 0) {
      const altTrustedSet = buildEntryMap(altTrusted);

      for (const item of results) {
        if (item.trustedEntry) continue;
        for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
          if (!entry?.allCharacters) continue;
          for (const c of entry.allCharacters) {
            const match = altTrustedSet.get(c.toLowerCase());
            if (match) {
              item.trustedEntry = match;
              item.matchDetails.trusted = { kind: 'roster', matchedName: c };
              break;
            }
          }
          if (item.trustedEntry) break;
        }
        if (!item.trustedEntry && Array.isArray(item.discoveredAlts)) {
          for (const c of item.discoveredAlts) {
            const match = altTrustedSet.get(c.toLowerCase());
            if (match) {
              item.trustedEntry = match;
              item.matchDetails.trusted = { kind: 'roster', matchedName: c };
              break;
            }
          }
        }
      }
    }
  }

  // Canonicalization can reveal a list hit that the original OCR spelling did
  // not query. Treat that real Mongo record as identity proof even when Bible
  // was unavailable, while leaving external-only unresolved names unverified.
  for (const item of results) {
    if (hasDatabaseListMatch(item)) {
      item.identityVerified = true;
      item.identityVerificationSource ||= 'list-database';
    }
  }

  // Class icons for the OTHER names a row prints: the entry it matched
  // through and the alts under it. Those were the only bare names left on
  // a row whose own name carries a class icon. Runs last so it sees the
  // final identity set (canonicalization and discovered alts included),
  // and is best-effort · a name never touched by /la-roster simply keeps
  // no icon.
  await attachRelatedClassNames(results);

  console.log([
    `[listcheck] Timing total=${Date.now() - startedAt}ms`,
    `names=${names.length}`,
    `connect=${connectMs}ms`,
    `initialDb=${initialDbMs}ms`,
    `correction=${correctionMs}ms`,
    `enrichment=${enrichmentMs}ms`,
    `refreshDb=${refreshDbMs}ms`,
    `trustedDb=${trustedDbMs}ms`,
  ].join(' '));
  return results;
}
