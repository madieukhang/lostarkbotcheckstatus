/**
 * Snapshot data for /la-list view.
 *
 * The list collections and this compact snapshot projection are loaded in
 * parallel. At the current production size the projection is about 250 KiB,
 * which is cheaper than showing an incomplete page and editing it again after
 * a second, sequential query for the visible rows.
 */

import RosterSnapshot from '../../../models/RosterSnapshot.js';
import { buildNameKeyMap } from '../../../utils/names.js';

const LIST_VIEW_SNAPSHOT_PROJECTION = Object.freeze({
  _id: 0,
  name: 1,
  classId: 1,
  itemLevel: 1,
  combatScore: 1,
  world: 1,
});

export async function loadListViewStatMap({
  RosterSnapshotModel = RosterSnapshot,
} = {}) {
  try {
    const snapshots = await RosterSnapshotModel
      .find({}, LIST_VIEW_SNAPSHOT_PROJECTION)
      .lean();
    return buildNameKeyMap(snapshots);
  } catch (err) {
    // Class/stat decoration is useful but must not make the list unavailable.
    console.warn('[list-view] Snapshot preload failed:', err.message);
    return new Map();
  }
}
