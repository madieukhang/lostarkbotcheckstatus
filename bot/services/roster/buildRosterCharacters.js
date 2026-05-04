import { JSDOM, VirtualConsole } from 'jsdom';

import { buildBibleFetchOptions, fetchWithFallback } from './bibleFetch.js';
import { fetchCharacterMeta } from './characterMeta.js';
import { inferHiddenRosterItemLevel } from './search.js';
import { detectAltsViaStronghold } from './altDetection.js';
import { extractRosterClassMapFromHtml } from './parsers.js';
import { getClassName } from '../../models/Class.js';

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => {});
virtualConsole.on('jsdomError', (err) => {
  if (err?.type === 'css parsing') return;
  console.warn('[jsdom] Parse warning:', err?.message || err);
});

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

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await fetchWithFallback(targetUrl, fetchOptions);

    if (!response.ok) {
      failReason = response.status === 429 ? 'Rate limited - try again later' : `HTTP ${response.status}`;
    } else {
      const html = await response.text();
      const { document } = new JSDOM(html, { virtualConsole }).window;
      const links = document.querySelectorAll('a[href^="/character/NA/"]');
      const rosterChars = [];
      // Class map lookup (name -> classId) parsed from the same html
      // block parsers.js#parseRosterCharactersFromHtml uses. Lets us
      // resolve the queried character's class without a second roster
      // page fetch · `name` matches case-sensitively against bible
      // capitalisation, so we lookup with the bible-cased charName
      // discovered in the loop below.
      const rosterClassMap = extractRosterClassMapFromHtml(html);

      for (const link of links) {
        const headerDiv = link.querySelector('.text-lg.font-semibold');
        if (!headerDiv) continue;

        const charName = [...headerDiv.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .find((t) => t.length > 0);

        if (!charName) continue;

        rosterChars.push(charName);

        if (charName.toLowerCase() === name.toLowerCase()) {
          const spans = headerDiv.querySelectorAll('span');
          const ilvlText = spans[0]?.textContent.trim() ?? '';
          const parsed = parseFloat(ilvlText.replace(/,/g, ''));
          if (!isNaN(parsed)) targetItemLevel = parsed;
          // Combat score is the second span on the header div. Class
          // id is from the JS-side rosterClassMap. Both are best-effort
          // (null when missing) so callers can render gracefully.
          const cpText = spans[1]?.textContent.trim() ?? '';
          if (cpText) targetCombatScore = cpText;
          const classId = rosterClassMap.get(charName);
          if (classId) targetClassName = getClassName(classId);
        }
      }

      if (rosterChars.length > 0) {
        hasValidRoster = true;
        rosterVisibility = 'visible';
        allCharacters = [...new Set(rosterChars)];
      } else if (hiddenRosterFallback) {
        const meta = await fetchCharacterMeta(name, options);
        if (meta) {
          hasValidRoster = true;
          rosterVisibility = 'hidden';
          targetItemLevel = meta.itemLevel ?? await inferHiddenRosterItemLevel(name, options);
          allCharacters = [name];

          if (includeHiddenRosterAlts && meta.guildName) {
            const altResult = await detectAltsViaStronghold(name, {
              targetMeta: meta,
              targetItemLevel,
              useScraperApiForCandidates: options.useScraperApiForCandidates,
              allowScraperApiForGuild: options.allowScraperApi,
            });
            const altNames = altResult?.alts?.map((alt) => alt.name).filter(Boolean) ?? [];
            allCharacters = [...new Set([name, ...altNames])];
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
  };
}
