export function buildNameRosterQuery(names = []) {
  const values = Array.isArray(names) ? names : [names];
  const list = [];
  const seen = new Set();
  for (const value of values) {
    const name = String(value || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
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
    map.set(String(entry.name || '').toLowerCase(), entry);
    for (const character of (entry.allCharacters || [])) {
      const lower = String(character || '').toLowerCase();
      if (!map.has(lower) || entry.scope === 'server') map.set(lower, entry);
    }
  }
  return map;
}

export function sortBlacklistForScopePriority(entries) {
  entries.sort((a, b) => (a.scope === 'server' ? 1 : 0) - (b.scope === 'server' ? 1 : 0));
  return entries;
}
