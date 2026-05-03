export function buildEntryMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.name.toLowerCase(), entry);
    for (const character of (entry.allCharacters || [])) {
      const lower = character.toLowerCase();
      if (!map.has(lower) || entry.scope === 'server') map.set(lower, entry);
    }
  }
  return map;
}

export function sortBlacklistForScopePriority(entries) {
  entries.sort((a, b) => (a.scope === 'server' ? 1 : 0) - (b.scope === 'server' ? 1 : 0));
  return entries;
}
