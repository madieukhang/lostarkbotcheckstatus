import { normalizeNameKey, normalizeNameList } from './names.js';

export function buildNameRosterQuery(names = []) {
  const list = normalizeNameList(names);
  return {
    $or: [
      { name: { $in: list } },
      { allCharacters: { $in: list } },
    ],
  };
}

function listEntryMatchRank(entry, isPrimary, { preferServerScope, preferredGuildId }) {
  let scopeRank = 0;
  if (preferServerScope && entry.scope === 'server') {
    scopeRank = preferredGuildId && entry.guildId === preferredGuildId ? 2 : 1;
  }
  return (scopeRank * 2) + (isPrimary ? 1 : 0);
}

function stableEntryKey(entry) {
  return [
    String(entry?.guildId || ''),
    normalizeNameKey(entry?.name),
    String(entry?._id || ''),
  ].join('\u0000');
}

function shouldReplaceSameRank(current, candidate, preferServerScope) {
  if (!preferServerScope) return false;
  const currentTime = new Date(current?.addedAt || 0).getTime() || 0;
  const candidateTime = new Date(candidate?.addedAt || 0).getTime() || 0;
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  return stableEntryKey(candidate) < stableEntryKey(current);
}

export function buildListEntryMap(entries, {
  preferServerScope = false,
  preferredGuildId = '',
} = {}) {
  const map = new Map();
  const rankByName = new Map();
  const policy = { preferServerScope, preferredGuildId };

  function indexName(rawName, entry, isPrimary = false) {
    const key = normalizeNameKey(rawName);
    if (!key) return;

    // Scope outranks match kind: the requesting guild's Server record wins,
    // followed by another visible Server record and then Global/legacy. Within
    // one tier an exact primary beats a tracked alias.
    const rank = listEntryMatchRank(entry, isPrimary, policy);
    const current = map.get(key);
    const currentRank = rankByName.get(key) ?? -1;
    if (current && (
      rank < currentRank
      || (rank === currentRank && !shouldReplaceSameRank(current, entry, preferServerScope))
    )) return;
    map.set(key, entry);
    rankByName.set(key, rank);
  }

  for (const entry of entries || []) {
    indexName(entry.name, entry, true);
    for (const character of (entry.allCharacters || [])) {
      indexName(character, entry);
    }
  }
  return map;
}

/** Pick one roster-wide hit with the same scope policy as the per-name map. */
export function pickPreferredListEntry(entries, names, options = {}) {
  const normalizedNames = normalizeNameList(names);
  const map = buildListEntryMap(entries, options);
  const policy = {
    preferServerScope: options.preferServerScope === true,
    preferredGuildId: options.preferredGuildId || '',
  };
  let selected = null;
  let selectedRank = -1;

  for (const name of normalizedNames) {
    const key = normalizeNameKey(name);
    const entry = map.get(key);
    if (!entry) continue;
    const rank = listEntryMatchRank(entry, normalizeNameKey(entry.name) === key, policy);
    if (rank <= selectedRank) continue;
    selected = entry;
    selectedRank = rank;
  }
  return selected;
}

/**
 * Build all four indexes in one policy-aware place. Blacklist rows returned by
 * the scope query can contain global and current-server records; the latter
 * must win without sorting or mutating the database result array first.
 */
export function buildListEntryMaps(
  { black = [], white = [], watch = [], trusted = [] },
  { preferredGuildId = '' } = {},
) {
  return {
    black: buildListEntryMap(black, { preferServerScope: true, preferredGuildId }),
    white: buildListEntryMap(white),
    watch: buildListEntryMap(watch),
    trusted: buildListEntryMap(trusted),
  };
}
