/**
 * Background data hydration for /la-list view.
 *
 * The first page render must not wait for Discord evidence-message fetches or
 * decorative class metadata. This module fills request-local caches after the
 * response is visible; the pure UI renderer then reuses those caches.
 */

import RosterSnapshot from '../../../models/RosterSnapshot.js';
import {
  getEvidenceMessageCacheKey,
  refreshImageUrl,
} from '../../../utils/imageRehost.js';
import { normalizeNameKey } from '../../../utils/names.js';
import { pickListViewAlts } from './ui.js';

const SNAPSHOT_COLLATION = Object.freeze({ locale: 'en', strength: 2 });

function rememberName(namesByKey, rawName) {
  const name = String(rawName || '').trim().normalize('NFC');
  const key = normalizeNameKey(name);
  if (key && !namesByKey.has(key)) namesByKey.set(key, name);
}

export function collectListViewCharacterNames(entries) {
  const namesByKey = new Map();
  for (const entry of entries || []) {
    rememberName(namesByKey, entry?.name);
    for (const altName of pickListViewAlts(entry)) {
      rememberName(namesByKey, altName);
    }
  }
  return namesByKey;
}

async function hydrateSnapshotCache({
  entries,
  loadedSnapshotNames,
  RosterSnapshotModel,
  statMap,
}) {
  const visibleNames = collectListViewCharacterNames(entries);
  const pendingNames = [...visibleNames]
    .filter(([key]) => !loadedSnapshotNames.has(key))
    .map(([, name]) => name);
  if (pendingNames.length === 0) return 0;

  const snapshots = await RosterSnapshotModel.find({ name: { $in: pendingNames } })
    .collation(SNAPSHOT_COLLATION)
    .lean();
  for (const key of visibleNames.keys()) loadedSnapshotNames.add(key);
  for (const snapshot of snapshots) {
    const key = normalizeNameKey(snapshot?.name);
    if (key) statMap.set(key, snapshot);
  }
  return snapshots.length;
}

async function hydrateEvidenceCache({
  client,
  entries,
  evidenceUrlCache,
  refreshImageUrlFn,
}) {
  const pendingByKey = new Map();
  for (const entry of entries || []) {
    const cacheKey = getEvidenceMessageCacheKey(entry);
    if (cacheKey && !evidenceUrlCache.has(cacheKey)) {
      pendingByKey.set(cacheKey, entry);
    }
  }

  const refreshed = await Promise.all([...pendingByKey].map(async ([cacheKey, entry]) => {
    try {
      const url = await refreshImageUrlFn(entry.imageMessageId, entry.imageChannelId, client);
      return [cacheKey, url || ''];
    } catch (err) {
      console.warn(`[list-view] Evidence refresh failed for ${cacheKey}:`, err.message);
      return [cacheKey, ''];
    }
  }));
  for (const [cacheKey, url] of refreshed) evidenceUrlCache.set(cacheKey, url);
  return refreshed.filter(([, url]) => Boolean(url)).length;
}

export async function hydrateListViewPage({
  client,
  entries,
  evidenceUrlCache = new Map(),
  loadedSnapshotNames = new Set(),
  refreshEvidence = true,
  refreshImageUrlFn = refreshImageUrl,
  RosterSnapshotModel = RosterSnapshot,
  statMap = new Map(),
} = {}) {
  const snapshotTask = hydrateSnapshotCache({
    entries,
    loadedSnapshotNames,
    RosterSnapshotModel,
    statMap,
  }).catch((err) => {
    console.warn('[list-view] Class snapshot hydration failed:', err.message);
    return 0;
  });
  const evidenceTask = refreshEvidence
    ? hydrateEvidenceCache({ client, entries, evidenceUrlCache, refreshImageUrlFn })
    : Promise.resolve(0);
  const [snapshotCount, evidenceCount] = await Promise.all([snapshotTask, evidenceTask]);
  return { evidenceCount, snapshotCount };
}
