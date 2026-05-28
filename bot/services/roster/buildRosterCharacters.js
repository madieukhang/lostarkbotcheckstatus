/**
 * services/roster/buildRosterCharacters.js
 * One-shot roster fetcher used by /la-list add + multiadd. Parses the
 * bible roster page, falls back to hidden-roster inference (search
 * API) when the page is gated, and optionally fans out to
 * detectAltsViaStronghold. Returns a normalised shape with all
 * possible failure reasons surfaced as `failReason` so the caller
 * can render a single embed without try/catch sprawl.
 */

import { JSDOM, VirtualConsole } from 'jsdom';

import { buildBibleFetchOptions } from './bibleFetch.js';
import { bibleClient } from './bibleClient.js';
import { fetchCharacterMeta } from './characterMeta.js';
import { inferHiddenRosterItemLevel } from './search.js';
import { detectAltsViaStronghold } from './altDetection.js';
import { parseRosterCharactersFromHtml } from './parsers.js';

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => {});
virtualConsole.on('jsdomError', (err) => {
  if (err?.type === 'css parsing') return;
  console.warn('[jsdom] Parse warning:', err?.message || err);
});

/**
 * Resolve a character's roster (siblings) via lostark.bible. Tries the
 * direct roster page first, then falls back to hidden-roster
 * inference + optional stronghold-based alt detection. Always returns
 * a result object (never throws) so callers don't have to wrap.
 * @param {string} name - target character name
 * @param {object} [options]
 * @param {boolean} [options.hiddenRosterFallback=false]
 * @param {boolean} [options.includeHiddenRosterAlts=false]
 * @param {boolean} [options.viaWorker] - forwarded to bibleClient
 * @returns {Promise<{allCharacters: string[], hasValidRoster: boolean, failReason: string|null, targetItemLevel: number|null, targetClassName: string|null, targetCombatScore: number|null, rosterVisibility: string, rosterCharacters: object[]}>}
 */
export async function buildRosterCharacters(name, options = {}) {
  const {
    hiddenRosterFallback = false,
    includeHiddenRosterAlts = false,
  } = options;
  const fetchOptions = buildBibleFetchOptions(options);

  let allCharacters = [name];
  let hasValidRoster = false;
  let failReason = null;
  let targetItemLevel = null;
  let targetClassName = null;
  let targetCombatScore = null;
  let rosterVisibility = 'missing';
  let rosterCharacters = [];

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await bibleClient.fetch(targetUrl, fetchOptions);

    if (!response.ok) {
      failReason = response.status === 429 ? 'Rate limited - try again later' : `HTTP ${response.status}`;
    } else {
      const html = await response.text();
      const { document } = new JSDOM(html, { virtualConsole }).window;

      // Use the canonical parser that /la-roster also uses. It returns
      // per-character records with name + itemLevel + combatScore +
      // classId + className already resolved. The previous inline
      // duplicate did its own DOM walk and a separate rosterClassMap
      // lookup that could silently fail for some names · routing
      // through the proven function eliminates that drift.
      const rosterChars = await parseRosterCharactersFromHtml(html, document);
      rosterCharacters = rosterChars;

      // Find the queried character's record in the parsed list. Match
      // is case-insensitive because OCR'd / user-typed names may not
      // match bible's capitalisation exactly.
      const targetRecord = rosterChars.find(
        (c) => String(c.name).toLowerCase() === String(name).toLowerCase()
      );
      if (targetRecord) {
        const parsedIlvl = parseFloat(String(targetRecord.itemLevel ?? '0').replace(/,/g, ''));
        if (!isNaN(parsedIlvl) && parsedIlvl > 0) targetItemLevel = parsedIlvl;
        if (targetRecord.combatScore && targetRecord.combatScore !== '?') {
          targetCombatScore = targetRecord.combatScore;
        }
        if (targetRecord.className) targetClassName = targetRecord.className;
      }

      if (rosterChars.length > 0) {
        hasValidRoster = true;
        rosterVisibility = 'visible';
        // Dedup by name string so two same-named entries (rare on
        // bible) collapse to one. Same shape as the old behaviour.
        allCharacters = [...new Set(rosterChars.map((c) => c.name))];
      } else if (hiddenRosterFallback) {
        const meta = await fetchCharacterMeta(name, options);
        if (meta) {
          hasValidRoster = true;
          rosterVisibility = 'hidden';
          targetItemLevel = meta.itemLevel ?? await inferHiddenRosterItemLevel(name, options);
          allCharacters = [name];
          rosterCharacters = [{
            name,
            classId: meta.classId || '',
            itemLevel: targetItemLevel || 0,
            combatScore: '',
          }];

          if (includeHiddenRosterAlts && meta.guildName) {
            const altResult = await detectAltsViaStronghold(name, {
              targetMeta: meta,
              targetItemLevel,
              useScraperApiForCandidates: options.useScraperApiForCandidates,
              allowScraperApiForGuild: options.allowScraperApi,
              viaWorker: options.viaWorker === true,
            });
            const altNames = altResult?.alts?.map((alt) => alt.name).filter(Boolean) ?? [];
            allCharacters = [...new Set([name, ...altNames])];
            rosterCharacters = [
              ...rosterCharacters,
              ...(altResult?.alts || []).filter((alt) => alt?.name),
            ];
          }
        }
      }
    }
  } catch (err) {
    failReason = err.name === 'TimeoutError' ? 'timeout' : err.message;
    console.warn('[list] Failed to fetch roster characters:', err.message);
  }

  return {
    hasValidRoster,
    allCharacters,
    failReason,
    targetItemLevel,
    targetClassName,
    targetCombatScore,
    rosterVisibility,
    rosterCharacters,
  };
}
