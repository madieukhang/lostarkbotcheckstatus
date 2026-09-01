import { normalizeNameKey } from './names.js';

export function buildNameRosterQuery(names = []) {
  const values = Array.isArray(names) ? names : [names];
  const list = [];
  const seen = new Set();
  for (const value of values) {
    const name = String(value || '').trim().normalize('NFC');
    if (!name) continue;
    const key = normalizeNameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(name);
  }
  return {
    $or: [
      { name: { $in: list } },
      { allCharacters: { $in: list } },
    ],
  };
}

export function buildListEntryMap(entries) {
  const map = new Map();
  for (const entry of entries || []) {
    const primaryKey = normalizeNameKey(entry.name);
    if (primaryKey) map.set(primaryKey, entry);
    for (const character of (entry.allCharacters || [])) {
      const key = normalizeNameKey(character);
      if (key && (!map.has(key) || entry.scope === 'server')) map.set(key, entry);
    }
  }
  return map;
}

export function sortBlacklistForScopePriority(entries) {
  entries.sort((a, b) => (a.scope === 'server' ? 1 : 0) - (b.scope === 'server' ? 1 : 0));
  return entries;
}
