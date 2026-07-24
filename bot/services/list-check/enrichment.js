import config from '../../config.js';
import { getClassName, resolveClassId } from '../../models/Class.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { fetchNameSuggestions } from '../roster/search.js';
import { buildRosterCharacters } from '../roster/buildRosterCharacters.js';
import { upsertRosterSnapshots } from '../roster/rosterSnapshots.js';
import { getWorkerHealth } from '../worker/heartbeat.js';
import { applyMarkedSiblingLevelCorrections } from './partyCorrections.js';
import {
  asciiFoldName,
  buildDiaeresisDigraphVariants,
  chooseCanonicalSuggestion,
  recoverViaPrefixIndel,
  recoverViaPrefixTransposition,
  recoverViaVisualSubstitution,
} from './nameRecovery.js';

export async function enrichListCheckResults(results, { suggestionCache } = {}) {
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
    //     Bible's search endpoint is lighter and can complete when CF blocks
    //     the per-character HTML page. It returns {name, cls, itemLevel}; the
    //     exact-name row supplies the persisted class and item level.
    // Both paths upsert the snapshot so the next OCR run hits cache.
    const health = await getWorkerHealth().catch(() => ({ online: false, reason: 'health-check-threw' }));

    const concurrency = config.listcheckRosterLookupConcurrency || 3;
    const lookupTimeoutMs = config.listcheckRosterLookupTimeoutMs || 6000;
    const enrichStartedAt = Date.now();
    const mode = health.online ? 'worker-meta' : 'search-direct';
    const pendingSnapshots = new Map();

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

    async function applySearchSuggestionEnrichment(item, searchOptions = {}) {
      const originalName = item.name;
      let suggestions = await fetchNameSuggestions(originalName, searchOptions);
      if (suggestions === null) return false;

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
          suggestions = await fetchNameSuggestions(folded, searchOptions);
          if (suggestions === null) return false;
        }
      }
      let match = chooseCanonicalSuggestion(originalName, suggestions);
      if (!match) {
        for (const variant of buildDiaeresisDigraphVariants(originalName)) {
          const variantSuggestions = await fetchNameSuggestions(variant, searchOptions);
          if (variantSuggestions === null) return false;
          const variantMatch = chooseCanonicalSuggestion(variant, variantSuggestions);
          if (variantMatch) {
            console.log(
              `[listcheck] Diaeresis-digraph recovery: OCR'd "${originalName}" -> query "${variant}"`
            );
            match = variantMatch;
            break;
          }
        }
      }
      if (!match) {
        const substituted = await recoverViaVisualSubstitution(originalName, searchOptions);
        if (substituted) {
          const recoveredName = normalizeCharacterName(substituted.name);
          if (!recoveredName) return false;
          console.log(
            `[listcheck] Visual-substitution recovery: OCR'd "${originalName}" -> canonical "${recoveredName}"`
          );
          if (recoveredName !== originalName) item.name = recoveredName;
          applyEnrichment(item, {
            classId: substituted.cls || '',
            itemLevel: Number(substituted.itemLevel) || 0,
          });
          return true;
        }

        const transposed = await recoverViaPrefixTransposition(originalName, searchOptions);
        if (transposed) {
          const recoveredName = normalizeCharacterName(transposed.name);
          if (!recoveredName) return false;
          console.log(
            `[listcheck] Prefix-transposition recovery: OCR'd "${originalName}" -> canonical "${recoveredName}"`
          );
          if (recoveredName !== originalName) item.name = recoveredName;
          applyEnrichment(item, {
            classId: transposed.cls || '',
            itemLevel: Number(transposed.itemLevel) || 0,
          });
          return true;
        }
        // Last resort: prefix-indel recovery for a single inserted /
        // dropped letter that bible's prefix-based search misses
        // entirely (so there were no suggestions for the 4-pass matcher
        // to work with). Already gated to exactly one distance-1 indel
        // candidate, so accept it directly · the fuzzy pass in
        // chooseCanonicalSuggestion bails under 6 chars and would reject
        // short recoveries like "Lpiiv" -> "Lpiiiv".
        const recovered = await recoverViaPrefixIndel(originalName, searchOptions);
        if (recovered) {
          const recoveredName = normalizeCharacterName(recovered.name);
          if (!recoveredName) return false;
          console.log(
            `[listcheck] Prefix-indel recovery: OCR'd "${originalName}" -> canonical "${recoveredName}"`
          );
          if (recoveredName !== originalName) item.name = recoveredName;
          applyEnrichment(item, {
            classId: recovered.cls || '',
            itemLevel: Number(recovered.itemLevel) || 0,
          });
          return true;
        }
        return false;
      }

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

      applyEnrichment(item, {
        classId: chosen.cls || '',
        itemLevel: Number(chosen.itemLevel) || 0,
      });
      return true;
    }

    await mapWithConcurrency(itemsNeedingEnrichment, concurrency, async (item) => {
      try {
        const searchOptions = { timeoutMs: lookupTimeoutMs, suggestionCache };
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
            await applySearchSuggestionEnrichment(item, { ...searchOptions, viaWorker: true });
            return;
          }
          // Resolve classId from the per-character record (parser gives
          // us classId directly), falling back to resolveClassId on the
          // display name when the record didn't surface a bible id.
          const targetRecord = (roster.rosterCharacters || []).find(
            (c) => String(c.name).toLowerCase() === item.name.toLowerCase()
          );
          // Canonicalize the display name to bible's exact spelling when
          // the roster scrape resolved the target. Mirrors the search-
          // direct branch so the embed shows bible's truth, not the OCR'd
          // casing/diacritics, regardless of which route resolved the row.
          // Done before the discoveredAlts filter + applyEnrichment below
          // so the snapshot key and self-exclusion both use the canonical
          // form.
          if (targetRecord?.name) {
            const canonical = normalizeCharacterName(targetRecord.name);
            if (canonical && canonical !== item.name) item.name = canonical;
          }
          const classId = targetRecord?.classId
            || (roster.targetClassName ? resolveClassId(roster.targetClassName) : '')
            || '';
          const rosterItemLevel = typeof roster.targetItemLevel === 'number' ? roster.targetItemLevel : 0;
          if (!classId && !rosterItemLevel) {
            await applySearchSuggestionEnrichment(item, { ...searchOptions, viaWorker: true });
            return;
          }
          applyEnrichment(item, {
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
          await applySearchSuggestionEnrichment(item, searchOptions);
        }
      } catch (err) {
        // Per-name failure is non-fatal: leave snap fields empty so the
        // formatter renders the bare name. Network / rate-limit /
        // timeout / search-API-blocked all land here.
        console.warn(`[listcheck] Enrichment (${mode}) skipped for ${item.name}: ${err.message}`);
      }
    });

    if (pendingSnapshots.size > 0) {
      try {
        await upsertRosterSnapshots([...pendingSnapshots.values()], '');
      } catch (saveErr) {
        // Persistence is best-effort. In-memory enrichment still renders
        // for this response; a later request can retry the snapshot write.
        console.warn(`[listcheck] Snapshot batch upsert failed: ${saveErr.message}`);
      }
    }

    console.log(
      `[listcheck] Enriched ${itemsNeedingEnrichment.length} name(s) via ${mode} in ${Date.now() - enrichStartedAt}ms`
    );

    await applyMarkedSiblingLevelCorrections(results);
  }
}
