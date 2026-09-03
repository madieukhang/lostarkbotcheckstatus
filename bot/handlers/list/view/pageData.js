/**
 * Background data hydration for /la-list view.
 *
 * The first page render must not wait for decorative class metadata. This
 * module fills the request-local snapshot cache after the response is visible;
 * the pure UI renderer then reuses it.
 */

import RosterSnapshot from '../../../models/RosterSnapshot.js';
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

export async function hydrateListViewPage({
  entries,
  loadedSnapshotNames = new Set(),
  RosterSnapshotModel = RosterSnapshot,
  statMap = new Map(),
} = {}) {
  try {
    const snapshotCount = await hydrateSnapshotCache({
      entries,
      loadedSnapshotNames,
      RosterSnapshotModel,
      statMap,
    });
    return { snapshotCount };
  } catch (err) {
    console.warn('[list-view] Class snapshot hydration failed:', err.message);
    return { snapshotCount: 0 };
  }
}
