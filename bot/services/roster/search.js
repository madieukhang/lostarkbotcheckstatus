/**
 * services/roster/search.js
 * Wrappers around the lostark.bible name-search API. The API speaks a
 * compact reference-payload JSON (numeric indices into a `data` array)
 * so the decoding here is invariant-critical · break it and search
 * autocomplete and hidden-roster inference both return null.
 * Reminder: this API is NFC-only and prefix-based with single-edit
 * tolerance · see [[reference-bible-api]] for the full behaviour notes.
 */

import { getClassName } from '../../models/Class.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildBibleFetchOptions } from './bibleFetch.js';
import { bibleClient } from './bibleClient.js';
import { parseItemLevelValue } from './parsers.js';

/**
 * Hit the bible name-search endpoint and decode the reference-payload
 * JSON into a `[{name, cls, itemLevel}]` array. Returns null on
 * transport error (caller distinguishes that from "no results").
 * @param {string} name - prefix or near-match candidate
 * @param {object} [options] - forwarded to buildBibleFetchOptions
 * @returns {Promise<Array<{name: string, cls: string, itemLevel: number|string}>|null>}
 */
export async function fetchNameSuggestions(name, options = {}) {
  try {
    const payload = Buffer.from(JSON.stringify([{ name: 1, region: 2 }, name, 'NA'])).toString('base64');
    const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
    const res = await bibleClient.fetch(targetUrl, buildBibleFetchOptions(options));
    if (!res.ok) {
      console.warn(`[search] lostark.bible search API returned HTTP ${res.status} for "${name}"`);
      return null;
    }

    const json = await res.json();
    if (json.type !== 'result' || !json.result) return [];

    const data = JSON.parse(json.result);
    if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].length === 0) return [];

    return data[0]
      .map((p) => {
        const group = data[p];
        if (!Array.isArray(group) || group.length < 3) return null;
        const [nameIdx, classIdx, ilvlIdx] = group;
        const charName = data[nameIdx];
        if (!charName || typeof charName !== 'string') return null;
        return {
          name: charName,
          cls: data[classIdx] ?? '',
          itemLevel: data[ilvlIdx] ?? 0,
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`[search] fetchNameSuggestions error for "${name}":`, err.message);
    return null;
  }
}

/**
 * Hidden-roster fallback · when a character's full roster page is
 * private but the name still appears in search results, the result can
 * provide the item level. Used by buildRosterCharacters'
 * hiddenRosterFallback path.
 * @param {string} name - exact character name (case-insensitive match)
 * @param {object} [options] - forwarded to fetchNameSuggestions
 * @returns {Promise<number|null>}
 */
export async function inferHiddenRosterItemLevel(name, options = {}) {
  const suggestions = await fetchNameSuggestions(name, options);
  const exact = suggestions?.find((s) => s.name?.toLowerCase() === name.toLowerCase());
  return exact ? parseItemLevelValue(exact.itemLevel) : null;
}

export function formatSuggestionLines(suggestions) {
  return suggestions
    .map((s) => `[${s.name}](${rosterUrl(s.name)}) · \`${Number(s.itemLevel).toFixed(2)}\` · ${getClassName(s.cls)}`)
    .join('\n');
}
