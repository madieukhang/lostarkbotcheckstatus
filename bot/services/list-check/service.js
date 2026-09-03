/**
 * services/list-check/service.js
 * Shared logic for checking character names against blacklist/whitelist/watchlist.
 * Used by both /la-check command and auto-check channel handler.
 */

import config from '../../config.js';
import { connectDB } from '../../db.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
import {
  buildListEntryMap as buildEntryMap,
  buildNameRosterQuery,
} from '../../utils/listEntryMap.js';
import {
  buildNameKeyMap,
  normalizeNameKey,
  normalizeNameList,
} from '../../utils/names.js';
import { createNameSuggestionContext } from '../roster/search.js';
import { enrichListCheckResults } from './enrichment.js';
import { LIST_LOOKUP_COLLATION, loadListLookup } from './lookup.js';
import {
  buildListMatchCandidates,
  didListCheckNameChange,
  resolveMappedListMatch,
} from './matchResolution.js';
import { applyMarkedSiblingLevelCorrections } from './partyCorrections.js';
import { attachRelatedClassNames } from './relatedClasses.js';
import { hasDatabaseListMatch } from './verification.js';

export { formatCheckResults } from './format.js';
export { extractNamesFromImage } from './ocr.js';
export {
  isCharacterIdentityVerified,
  partitionListCheckResultsByVerification,
} from './verification.js';

// ─── Name checking ──────────────────────────────────────────────────────────

function rememberNormalizedName(namesByKey, rawName) {
  const name = String(rawName || '').trim().normalize('NFC');
  const key = normalizeNameKey(name);
  if (key && !namesByKey.has(key)) namesByKey.set(key, name);
}

async function loadInitialListData(names, guildId) {
  const [lookup, snapshots] = await Promise.all([
    loadListLookup(names, { guildId }),
    RosterSnapshot.find({ name: { $in: names } }).collation(LIST_LOOKUP_COLLATION).lean(),
  ]);
  return {
    maps: lookup.maps,
    snapshots: buildNameKeyMap(snapshots),
  };
}

function resolveAllMappedMatches(maps, candidates) {
  return {
    black: resolveMappedListMatch(maps.black, candidates),
    white: resolveMappedListMatch(maps.white, candidates),
    watch: resolveMappedListMatch(maps.watch, candidates),
    trusted: resolveMappedListMatch(maps.trusted, candidates),
  };
}

function createInitialListCheckResult(name, inputSource, maps, snapshots) {
  const snapshot = snapshots.get(normalizeNameKey(name)) || null;
  const matches = resolveAllMappedMatches(maps, [{ name, origin: 'checked' }]);
  const initialListMatch = Object.values(matches).some((match) => Boolean(match.entry));
  return {
    inputName: name,
    inputSource,
    name,
    blackEntry: matches.black.entry,
    whiteEntry: matches.white.entry,
    watchEntry: matches.watch.entry,
    trustedEntry: matches.trusted.entry,
    identityVerified: Boolean(snapshot || initialListMatch),
    identityVerificationSource: initialListMatch
      ? 'list-database'
      : snapshot
        ? 'roster-snapshot'
        : null,
    matchDetails: {
      black: matches.black.detail,
      white: matches.white.detail,
      watch: matches.watch.detail,
      trusted: matches.trusted.detail,
    },
    hasRoster: false,
    failReason: null,
    similarNames: null,
    snapClassId: snapshot?.classId || '',
    snapClassName: snapshot?.classId ? getClassName(snapshot.classId) : '',
    snapItemLevel: snapshot?.itemLevel || 0,
    snapCombatScore: snapshot?.combatScore || '',
    discoveredAlts: [],
  };
}

function replaceListMatches(item, maps) {
  const matches = resolveAllMappedMatches(maps, buildListMatchCandidates(item));
  for (const listType of ['black', 'white', 'watch', 'trusted']) {
    item[`${listType}Entry`] = matches[listType].entry;
    item.matchDetails[listType] = matches[listType].detail;
  }
}

async function reconcileEnrichedListMatches(results, guildId) {
  const items = results.filter((item) => (
    didListCheckNameChange(item)
    || (Array.isArray(item.discoveredAlts) && item.discoveredAlts.length > 0)
  ));
  const namesByKey = new Map();
  for (const item of items) {
    for (const candidate of buildListMatchCandidates(item)) {
      rememberNormalizedName(namesByKey, candidate.name);
    }
  }
  if (namesByKey.size === 0) return 0;

  const startedAt = Date.now();
  const { maps } = await loadListLookup([...namesByKey.values()], { guildId });
  const elapsedMs = Date.now() - startedAt;
  for (const item of items) replaceListMatches(item, maps);
  return elapsedMs;
}

function collectTrustedAltNames(results) {
  const namesByKey = new Map();
  for (const item of results) {
    if (item.trustedEntry) continue;
    for (const rawName of rosterRelationshipNames(item)) {
      rememberNormalizedName(namesByKey, rawName);
    }
  }
  return namesByKey;
}

function* rosterRelationshipNames(item) {
  for (const entry of [item.blackEntry, item.whiteEntry, item.watchEntry]) {
    yield* (entry?.allCharacters || []);
  }
  yield* (Array.isArray(item.discoveredAlts) ? item.discoveredAlts : []);
}

function findTrustedRosterMatch(item, trustedMap) {
  for (const name of rosterRelationshipNames(item)) {
    const match = trustedMap.get(normalizeNameKey(name));
    if (match) return { entry: match, matchedName: name };
  }
  return null;
}

async function resolveTrustedRosterMatches(results) {
  const namesByKey = collectTrustedAltNames(results);
  if (namesByKey.size === 0) return 0;

  const startedAt = Date.now();
  const entries = await TrustedUser.find(buildNameRosterQuery([...namesByKey.values()]))
    .collation(LIST_LOOKUP_COLLATION)
    .lean();
  const elapsedMs = Date.now() - startedAt;
  if (entries.length === 0) return elapsedMs;

  const trustedMap = buildEntryMap(entries);
  for (const item of results) {
    if (item.trustedEntry) continue;
    const match = findTrustedRosterMatch(item, trustedMap);
    if (!match) continue;
    item.trustedEntry = match.entry;
    item.matchDetails.trusted = { kind: 'roster', matchedName: match.matchedName };
  }
  return elapsedMs;
}

function markDatabaseVerifiedIdentities(results) {
  for (const item of results) {
    if (!hasDatabaseListMatch(item)) continue;
    item.identityVerified = true;
    item.identityVerificationSource ||= 'list-database';
  }
}

function logListCheckTiming(startedAt, names, timings) {
  console.log([
    `[listcheck] Timing total=${Date.now() - startedAt}ms`,
    `names=${names.length}`,
    `connect=${timings.connect}ms`,
    `initialDb=${timings.initialDb}ms`,
    `correction=${timings.correction}ms`,
    `enrichment=${timings.enrichment}ms`,
    `refreshDb=${timings.refreshDb}ms`,
    `trustedDb=${timings.trustedDb}ms`,
    `relatedClass=${timings.relatedClass}ms`,
  ].join(' '));
}

/**
 * Check an array of names against database-backed lists.
 *
 * After DB cross-check, missing character metadata goes through bounded Bible
 * enrichment. The checked names and the three alt names the card can display
 * share one request cache and network budget; related-name repair is direct
 * only and never spends ScraperAPI quota.
 *
 * @param {string[]} names
 * @param {object} [options]
 * @param {string} [options.guildId] - Guild ID for server-scoped blacklist entries
 * @param {'ocr'|'text'} [options.inputSource='text'] - How names were supplied
 * @param {Map} [options.suggestionCache] - request-local Bible search cache
 * @param {object} [options.suggestionContext] - request-wide lookup budget and metrics
 * @returns {Promise<Array<object>>} Results with list and snapshot metadata
 */
export async function checkNamesAgainstLists(names, options = {}) {
  const startedAt = Date.now();
  // OCR refinement can collapse two candidates into the same canonical name;
  // enforcing uniqueness here protects every caller and avoids duplicate DB,
  // enrichment, and render work while retaining the image/text input order.
  const checkedNames = normalizeNameList(names);
  if (checkedNames.length === 0) return [];
  const connectStartedAt = Date.now();
  await connectDB();
  const connectMs = Date.now() - connectStartedAt;
  const {
    guildId,
    inputSource = 'text',
    suggestionCache,
    suggestionContext,
  } = options;
  const requestSuggestionContext = suggestionContext || createNameSuggestionContext({
    cache: suggestionCache,
    maxNetworkLookups: config.listcheckSuggestionLookupBudget,
  });

  const initialDbStartedAt = Date.now();
  const initialData = await loadInitialListData(checkedNames, guildId);
  const initialDbMs = Date.now() - initialDbStartedAt;
  const results = checkedNames.map((name) => createInitialListCheckResult(
    name,
    inputSource,
    initialData.maps,
    initialData.snapshots
  ));

  // Targeted class/ilvl enrichment lives in its own module so this
  // service stays focused on DB orchestration.
  const enrichmentStartedAt = Date.now();
  const enrichmentOutcome = await enrichListCheckResults(results, {
    suggestionCache,
    suggestionContext: requestSuggestionContext,
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
  const refreshDbMs = await reconcileEnrichedListMatches(results, guildId);

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
  const trustedDbMs = await resolveTrustedRosterMatches(results);

  // Canonicalization can reveal a list hit that the original OCR spelling did
  // not query. Treat that real Mongo record as identity proof even when Bible
  // was unavailable, while leaving external-only unresolved names unverified.
  markDatabaseVerifiedIdentities(results);

  // Class icons for the OTHER names a row prints: the entry it matched
  // through and the alts under it. Those were the only bare names left on
  // a row whose own name carries a class icon. Runs last so it sees the
  // final identity set (canonicalization and discovered alts included),
  // and is best-effort · if both snapshot and direct search are unavailable,
  // the name remains a valid bare roster link.
  const relatedClassStartedAt = Date.now();
  await attachRelatedClassNames(results, {
    suggestionCache,
    suggestionContext: requestSuggestionContext,
  });
  const relatedClassMs = Date.now() - relatedClassStartedAt;

  logListCheckTiming(startedAt, checkedNames, {
    connect: connectMs,
    initialDb: initialDbMs,
    correction: correctionMs,
    enrichment: enrichmentMs,
    refreshDb: refreshDbMs,
    trustedDb: trustedDbMs,
    relatedClass: relatedClassMs,
  });
  return results;
}
