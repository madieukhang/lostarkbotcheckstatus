import config from '../../config.js';
import { getClassName, resolveClassId } from '../../models/Class.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { buildRosterCharacters } from '../roster/buildRosterCharacters.js';
import {
  createNameSuggestionContext,
  fetchNameSuggestions,
} from '../roster/search.js';
import { upsertRosterSnapshots } from '../roster/rosterSnapshots.js';
import { getWorkerHealth } from '../worker/heartbeat.js';
import {
  asciiFoldName,
  buildDiaeresisDigraphVariants,
  chooseCanonicalSuggestion,
  recoverViaPrefixIndel,
  recoverViaPrefixTransposition,
  recoverViaVisualSubstitution,
} from './nameRecovery.js';
import { applyMarkedSiblingLevelCorrections } from './partyCorrections.js';

const LOOKUP_RESOLVED = 'resolved';
const LOOKUP_UNRESOLVED = 'unresolved';
const LOOKUP_UNAVAILABLE = 'unavailable';

export async function enrichListCheckResults(
  results,
  { suggestionCache, suggestionContext } = {},
) {
  const itemsNeedingEnrichment = results.filter(
    (item) => !item.snapClassId || !item.snapItemLevel
  );
  if (itemsNeedingEnrichment.length === 0) return;

  // Worker health is checked once for the whole batch. A healthy worker gets
  // the richer roster-page route; every worker miss falls back to the direct
  // lightweight search endpoint.
  const health = await getWorkerHealth()
    .catch(() => ({ online: false, reason: 'health-check-threw' }));
  const concurrency = config.listcheckRosterLookupConcurrency || 3;
  const lookupTimeoutMs = config.listcheckRosterLookupTimeoutMs || 6000;
  const deepLimit = Math.max(1, config.listcheckSimilarLookupLimit || 3);
  const enrichStartedAt = Date.now();
  const mode = health.online ? 'worker-meta' : 'search-direct';
  const pendingSnapshots = new Map();
  const lookupContext = suggestionContext || createNameSuggestionContext({
    cache: suggestionCache,
    maxNetworkLookups: config.listcheckSuggestionLookupBudget,
  });
  let workerResolved = 0;

  function searchOptions(extra = {}) {
    return {
      timeoutMs: lookupTimeoutMs,
      suggestionCache,
      suggestionContext: lookupContext,
      ...extra,
    };
  }

  function applyEnrichment(item, { classId, itemLevel, combatScore }) {
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
    pendingSnapshots.set(String(item.name).toLowerCase(), {
      name: item.name,
      itemLevel,
      classId,
      combatScore,
    });
  }

  function applySuggestionMatch(item, originalName, match) {
    const { chosen, reason, distance, maxDistance } = match;
    const chosenName = normalizeCharacterName(chosen.name);
    if (!chosenName) return LOOKUP_UNRESOLVED;

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

    applyEnrichment(item, {
      classId: chosen.cls || '',
      itemLevel: Number(chosen.itemLevel) || 0,
    });
    return LOOKUP_RESOLVED;
  }

  function applyRecoveredSuggestion(item, originalName, recovered, label) {
    const recoveredName = normalizeCharacterName(recovered?.name);
    if (!recoveredName) return LOOKUP_UNRESOLVED;
    console.log(
      `[listcheck] ${label}: OCR'd "${originalName}" -> canonical "${recoveredName}"`
    );
    if (recoveredName !== originalName) item.name = recoveredName;
    applyEnrichment(item, {
      classId: recovered.cls || '',
      itemLevel: Number(recovered.itemLevel) || 0,
    });
    return LOOKUP_RESOLVED;
  }

  /**
   * Fast phase: one exact query plus at most one ASCII-fold retry. This phase
   * runs for the full batch before any speculative recovery can occupy a lane.
   */
  async function applyPrimarySearchEnrichment(item) {
    const originalName = item.name;
    let suggestions = await fetchNameSuggestions(originalName, searchOptions());
    if (suggestions === null) return LOOKUP_UNAVAILABLE;

    if (suggestions.length === 0) {
      const folded = asciiFoldName(originalName);
      if (folded && folded !== originalName.toLowerCase()) {
        console.log(
          `[listcheck] Search empty for "${originalName}", retrying with ASCII fold "${folded}"`
        );
        suggestions = await fetchNameSuggestions(folded, searchOptions());
        if (suggestions === null) return LOOKUP_UNAVAILABLE;
      }
    }

    const match = chooseCanonicalSuggestion(originalName, suggestions);
    return match
      ? applySuggestionMatch(item, originalName, match)
      : LOOKUP_UNRESOLVED;
  }

  /**
   * Slow phase: typo/visual recovery. Only the first bounded set of unresolved
   * rows reaches this function, and all calls share the same request budget.
   */
  async function applyDeepSearchRecovery(item) {
    const originalName = item.name;
    for (const variant of buildDiaeresisDigraphVariants(originalName)) {
      const variantSuggestions = await fetchNameSuggestions(variant, searchOptions());
      if (variantSuggestions === null) return LOOKUP_UNAVAILABLE;
      const variantMatch = chooseCanonicalSuggestion(variant, variantSuggestions);
      if (variantMatch) {
        console.log(
          `[listcheck] Diaeresis-digraph recovery: OCR'd "${originalName}" -> query "${variant}"`
        );
        return applySuggestionMatch(item, originalName, variantMatch);
      }
    }

    const recoveryOptions = searchOptions({ recoveryCandidateLimit: deepLimit });
    const substituted = await recoverViaVisualSubstitution(originalName, recoveryOptions);
    if (substituted) {
      return applyRecoveredSuggestion(
        item,
        originalName,
        substituted,
        'Visual-substitution recovery',
      );
    }

    const transposed = await recoverViaPrefixTransposition(originalName, recoveryOptions);
    if (transposed) {
      return applyRecoveredSuggestion(
        item,
        originalName,
        transposed,
        'Prefix-transposition recovery',
      );
    }

    const recovered = await recoverViaPrefixIndel(originalName, recoveryOptions);
    if (recovered) {
      return applyRecoveredSuggestion(
        item,
        originalName,
        recovered,
        'Prefix-indel recovery',
      );
    }
    return LOOKUP_UNRESOLVED;
  }

  const primaryStatuses = await mapWithConcurrency(
    itemsNeedingEnrichment,
    concurrency,
    async (item) => {
      try {
        if (!health.online) {
          return applyPrimarySearchEnrichment(item);
        }

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

        // Important: this fallback is intentionally direct. Passing
        // viaWorker:true here would send the retry back through the route that
        // just failed.
        if (!roster || !roster.hasValidRoster) {
          return applyPrimarySearchEnrichment(item);
        }

        const targetRecord = (roster.rosterCharacters || []).find(
          (character) => String(character.name).toLowerCase() === item.name.toLowerCase()
        );
        if (targetRecord?.name) {
          const canonical = normalizeCharacterName(targetRecord.name);
          if (canonical && canonical !== item.name) item.name = canonical;
        }

        const classId = targetRecord?.classId
          || (roster.targetClassName ? resolveClassId(roster.targetClassName) : '')
          || '';
        const rosterItemLevel = typeof roster.targetItemLevel === 'number'
          ? roster.targetItemLevel
          : 0;
        if (!classId && !rosterItemLevel) {
          return applyPrimarySearchEnrichment(item);
        }

        applyEnrichment(item, {
          classId,
          itemLevel: rosterItemLevel,
          combatScore: roster.targetCombatScore || targetRecord?.combatScore || '',
        });
        if (roster.rosterVisibility === 'visible' && Array.isArray(roster.allCharacters)) {
          item.discoveredAlts = roster.allCharacters.filter(
            (name) => String(name).toLowerCase() !== item.name.toLowerCase()
          );
        }
        workerResolved += 1;
        return LOOKUP_RESOLVED;
      } catch (err) {
        console.warn(`[listcheck] Enrichment (${mode}) skipped for ${item.name}: ${err.message}`);
        return LOOKUP_UNAVAILABLE;
      }
    },
  );

  const unresolvedItems = itemsNeedingEnrichment.filter(
    (_item, index) => primaryStatuses[index] === LOOKUP_UNRESOLVED
  );
  const deepCandidates = unresolvedItems.slice(0, deepLimit);
  const deepStatuses = await mapWithConcurrency(
    deepCandidates,
    concurrency,
    async (item) => {
      try {
        return await applyDeepSearchRecovery(item);
      } catch (err) {
        console.warn(`[listcheck] Deep recovery skipped for ${item.name}: ${err.message}`);
        return LOOKUP_UNAVAILABLE;
      }
    },
  );

  if (pendingSnapshots.size > 0) {
    try {
      await upsertRosterSnapshots([...pendingSnapshots.values()], '');
    } catch (saveErr) {
      // Persistence is best effort. The current response still uses the
      // in-memory metadata and a later request can retry the snapshot write.
      console.warn(`[listcheck] Snapshot batch upsert failed: ${saveErr.message}`);
    }
  }

  const primaryResolved = primaryStatuses.filter(
    (status) => status === LOOKUP_RESOLVED
  ).length;
  const deepResolved = deepStatuses.filter(
    (status) => status === LOOKUP_RESOLVED
  ).length;
  const lookupStats = lookupContext.stats || {};
  console.log([
    `[listcheck] Enrichment timing total=${Date.now() - enrichStartedAt}ms`,
    `mode=${mode}`,
    `resolved=${primaryResolved + deepResolved}/${itemsNeedingEnrichment.length}`,
    `primary=${primaryResolved}`,
    `worker=${workerResolved}`,
    `deep=${deepResolved}/${deepCandidates.length}`,
    `deepSkipped=${Math.max(0, unresolvedItems.length - deepCandidates.length)}`,
    `network=${lookupStats.networkLookups || 0}`,
    `requestCache=${lookupStats.requestCacheHits || 0}`,
    `sharedCache=${lookupStats.sharedCacheHits || 0}`,
    `budgetExhausted=${lookupStats.budgetExhaustions || 0}`,
  ].join(' '));

  await applyMarkedSiblingLevelCorrections(results);
}
