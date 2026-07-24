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

function decodeSearchResponse(json) {
  if (json?.type !== 'result') {
    throw new Error(`Unsupported search response type: ${json?.type || 'missing'}`);
  }

  // lostark.bible moved the encoded reference table from `result` to
  // `data` and wrapped its root array behind a `{ _: <index> }` pointer.
  // Accept both envelopes so an upstream rollout does not turn every
  // valid name into a false "no matches" result.
  const encodedTable = json.data ?? json.result;
  const table = typeof encodedTable === 'string'
    ? JSON.parse(encodedTable)
    : encodedTable;

  if (!Array.isArray(table)) {
    throw new Error('Unsupported search response table');
  }

  let rowRefs = table[0];
  if (!Array.isArray(rowRefs)) {
    const rootIndex = rowRefs?._;
    if (!Number.isInteger(rootIndex) || !Array.isArray(table[rootIndex])) {
      throw new Error('Unsupported search response root');
    }
    rowRefs = table[rootIndex];
  }

  return rowRefs.map((pointer) => {
    const group = table[pointer];
    if (!Array.isArray(group) || group.length < 3) {
      throw new Error('Unsupported search response row');
    }

    const [nameIdx, classIdx, ilvlIdx] = group;
    const charName = table[nameIdx];
    if (!charName || typeof charName !== 'string') {
      throw new Error('Unsupported search response name');
    }

    return {
      name: charName,
      cls: table[classIdx] ?? '',
      itemLevel: table[ilvlIdx] ?? 0,
    };
  });
}

/**
 * Hit the bible name-search endpoint and decode the reference-payload
 * JSON into a `[{name, cls, itemLevel}]` array. Returns null on
 * transport error (caller distinguishes that from "no results").
 * @param {string} name - prefix or near-match candidate
 * @param {object} [options] - forwarded to buildBibleFetchOptions
 * @param {Map} [options.suggestionCache] - request-local cache that also
 *   deduplicates concurrent lookups for the same normalized query
 * @returns {Promise<Array<{name: string, cls: string, itemLevel: number|string}>|null>}
 */
export async function fetchNameSuggestions(name, options = {}) {
  const { suggestionCache, ...fetchOptions } = options;
  const cacheKey = String(name || '').normalize('NFC').toLowerCase();
  const canCache = suggestionCache instanceof Map && Boolean(cacheKey);

  if (canCache && suggestionCache.has(cacheKey)) {
    return suggestionCache.get(cacheKey);
  }

  const request = (async () => {
    try {
      const payload = Buffer.from(JSON.stringify([{ name: 1, region: 2 }, name, 'NA'])).toString('base64');
      const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
      const res = await bibleClient.fetch(targetUrl, buildBibleFetchOptions(fetchOptions));
      if (!res.ok) {
        console.warn(`[search] lostark.bible search API returned HTTP ${res.status} for "${name}"`);
        return null;
      }

      const json = await res.json();
      return decodeSearchResponse(json);
    } catch (err) {
      console.warn(`[search] fetchNameSuggestions error for "${name}":`, err.message);
      return null;
    }
  })();

  if (canCache) suggestionCache.set(cacheKey, request);

  try {
    const result = await request;
    // Keep successful and empty lookups for this request. Transport or
    // contract failures remain retryable if the upstream recovers.
    if (canCache && result === null) suggestionCache.delete(cacheKey);
    return result;
  } catch (err) {
    if (canCache) suggestionCache.delete(cacheKey);
    throw err;
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
