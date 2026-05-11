export function shouldCacheRosterLookupResult(rosterResult) {
  return rosterResult?.hasValidRoster === true;
}

export function shouldRescrapeCachedRoster(cached) {
  if (!cached?.hasRoster) return false;
  if (cached.rosterVisibility === 'hidden') return false;
  return !cached.targetClassName;
}
