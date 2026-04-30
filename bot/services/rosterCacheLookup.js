function normalizeCacheKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isExactEntryForKey(entry, key) {
  return normalizeCacheKey(entry?.name) === key;
}

function getCachedAtMs(entry) {
  const value = entry?.cachedAt instanceof Date
    ? entry.cachedAt.getTime()
    : Date.parse(entry?.cachedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function shouldPreferCacheEntry(candidate, current, key) {
  if (!current) return true;

  const candidateHasRoster = Boolean(candidate?.hasRoster);
  const currentHasRoster = Boolean(current?.hasRoster);
  if (candidateHasRoster !== currentHasRoster) return candidateHasRoster;

  const candidateExact = isExactEntryForKey(candidate, key);
  const currentExact = isExactEntryForKey(current, key);
  if (candidateExact !== currentExact) return candidateExact;

  return getCachedAtMs(candidate) > getCachedAtMs(current);
}

export function buildRosterCacheLookupMap(cachedEntries = []) {
  const map = new Map();

  for (const entry of cachedEntries || []) {
    const keys = new Set([entry?.name, ...(entry?.allCharacters || [])]);
    for (const rawKey of keys) {
      const key = normalizeCacheKey(rawKey);
      if (!key) continue;
      const current = map.get(key);
      if (shouldPreferCacheEntry(entry, current, key)) {
        map.set(key, entry);
      }
    }
  }

  return map;
}

export function getRosterCacheMatch(cacheMap, name) {
  return cacheMap.get(normalizeCacheKey(name)) || null;
}
