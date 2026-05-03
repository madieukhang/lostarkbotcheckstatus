import { getClassName } from '../../models/Class.js';
import { buildBibleFetchOptions, fetchWithFallback } from './bibleFetch.js';
import { parseItemLevelValue } from './parsers.js';

export async function fetchNameSuggestions(name, options = {}) {
  try {
    const payload = Buffer.from(JSON.stringify([{ name: 1, region: 2 }, name, 'NA'])).toString('base64');
    const targetUrl = `https://lostark.bible/_app/remote/ngsbie/search?payload=${encodeURIComponent(payload)}`;
    const res = await fetchWithFallback(targetUrl, buildBibleFetchOptions(options));
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

export async function inferHiddenRosterItemLevel(name, options = {}) {
  const suggestions = await fetchNameSuggestions(name, options);
  const exact = suggestions?.find((s) => s.name?.toLowerCase() === name.toLowerCase());
  return exact ? parseItemLevelValue(exact.itemLevel) : null;
}

export function formatSuggestionLines(suggestions) {
  return suggestions
    .map((s) => `[${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel).toFixed(2)}\` — ${getClassName(s.cls)}`)
    .join('\n');
}
