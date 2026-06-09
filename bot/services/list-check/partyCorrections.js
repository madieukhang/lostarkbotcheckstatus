import RosterSnapshot from '../../models/RosterSnapshot.js';
import { getClassName } from '../../models/Class.js';
import { hasAnyDiacritic, medianNumber, stripDiacritics } from './nameRecovery.js';

export async function applyMarkedSiblingLevelCorrections(results) {
  const exactUnmarked = results.filter(
    (item) => item?.name
      && !hasAnyDiacritic(item.name)
      && item.snapItemLevel > 0
  );
  if (exactUnmarked.length === 0) return;

  const names = exactUnmarked.map((item) => item.name);
  const siblingSnapshots = await RosterSnapshot.find({ name: { $in: names } })
    .collation({ locale: 'en', strength: 1 })
    .lean();
  if (siblingSnapshots.length === 0) return;

  const snapshotsByBase = new Map();
  for (const snap of siblingSnapshots) {
    const base = stripDiacritics(snap.name);
    if (!snap.itemLevel || !snap.classId) continue;
    if (!snapshotsByBase.has(base)) snapshotsByBase.set(base, []);
    snapshotsByBase.get(base).push(snap);
  }

  for (const item of exactUnmarked) {
    const otherLevels = results
      .filter((other) => other !== item && other.snapItemLevel > 0)
      .map((other) => Number(other.snapItemLevel));
    if (otherLevels.length < 3) continue;

    const partyMedian = medianNumber(otherLevels);
    if (!Number.isFinite(partyMedian)) continue;

    const base = stripDiacritics(item.name);
    const candidates = (snapshotsByBase.get(base) || [])
      .filter((snap) => {
        const sameExact = String(snap.name).toLowerCase() === String(item.name).toLowerCase();
        return !sameExact && hasAnyDiacritic(snap.name) && Number(snap.itemLevel) > 0;
      })
      .map((snap) => ({
        snap,
        distance: Math.abs(Number(snap.itemLevel) - partyMedian),
      }))
      .sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) continue;
    if (candidates.length > 1 && candidates[0].distance === candidates[1].distance) continue;

    const exactDistance = Math.abs(Number(item.snapItemLevel) - partyMedian);
    const best = candidates[0];
    const exactIsLowOutlier = Number(item.snapItemLevel) <= partyMedian - 50;
    const markedFitsParty = best.distance <= 40;
    const markedIsMuchCloser = exactDistance - best.distance >= 50;
    if (!exactIsLowOutlier || !markedFitsParty || !markedIsMuchCloser) continue;

    console.log(
      `[listcheck] Party-level accent correction: "${item.name}" (${Number(item.snapItemLevel).toFixed(2)}) -> "${best.snap.name}" (${Number(best.snap.itemLevel).toFixed(2)}), median ${partyMedian.toFixed(2)}`
    );
    item.name = best.snap.name;
    item.snapClassId = best.snap.classId || '';
    item.snapClassName = best.snap.classId ? getClassName(best.snap.classId) : '';
    item.snapItemLevel = Number(best.snap.itemLevel) || 0;
    item.snapCombatScore = best.snap.combatScore || '';
  }
}
