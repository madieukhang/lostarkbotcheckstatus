import RosterSnapshot from '../../models/RosterSnapshot.js';
import { getClassName } from '../../models/Class.js';
import { hasAnyDiacritic, stripDiacritics } from './nameRecovery.js';

/**
 * Return the median after excluding one position from an already sorted
 * numeric array. The caller sorts once for the whole OCR batch, avoiding a
 * filter + sort for every candidate row.
 */
export function medianExcludingSortedIndex(sortedValues, excludedIndex) {
  if (
    !Array.isArray(sortedValues)
    || sortedValues.length <= 1
    || !Number.isInteger(excludedIndex)
    || excludedIndex < 0
    || excludedIndex >= sortedValues.length
  ) {
    return null;
  }

  const remainingLength = sortedValues.length - 1;
  const valueAt = (index) => sortedValues[index < excludedIndex ? index : index + 1];
  const middle = Math.floor(remainingLength / 2);
  return remainingLength % 2 === 1
    ? valueAt(middle)
    : (valueAt(middle - 1) + valueAt(middle)) / 2;
}

export async function applyMarkedSiblingLevelCorrections(results) {
  const exactUnmarked = results.filter(
    (item) => item?.name
      && !hasAnyDiacritic(item.name)
      && item.snapItemLevel > 0
  );
  if (exactUnmarked.length === 0) return;

  // Use one immutable level snapshot for the whole correction pass. Besides
  // reducing median work from O(N² log N) to O(N log N), this prevents an
  // earlier correction from changing the decision for a later OCR row.
  const sortedPartyEntries = results
    .map((item) => ({ item, level: Number(item?.snapItemLevel) }))
    .filter(({ level }) => Number.isFinite(level) && level > 0)
    .sort((a, b) => a.level - b.level);
  if (sortedPartyEntries.length < 4) return;

  const sortedPartyLevels = sortedPartyEntries.map(({ level }) => level);
  const partyIndexByItem = new Map(
    sortedPartyEntries.map(({ item }, index) => [item, index])
  );

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

  const corrections = [];
  for (const item of exactUnmarked) {
    const itemIndex = partyIndexByItem.get(item);
    const partyMedian = medianExcludingSortedIndex(sortedPartyLevels, itemIndex);
    if (!Number.isFinite(partyMedian)) continue;

    const base = stripDiacritics(item.name);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestIsTied = false;
    for (const snap of snapshotsByBase.get(base) || []) {
      const sameExact = String(snap.name).toLowerCase() === String(item.name).toLowerCase();
      if (sameExact || !hasAnyDiacritic(snap.name) || Number(snap.itemLevel) <= 0) continue;

      const distance = Math.abs(Number(snap.itemLevel) - partyMedian);
      if (distance < bestDistance) {
        best = snap;
        bestDistance = distance;
        bestIsTied = false;
      } else if (distance === bestDistance) {
        bestIsTied = true;
      }
    }
    if (!best || bestIsTied) continue;

    const exactDistance = Math.abs(Number(item.snapItemLevel) - partyMedian);
    const exactIsLowOutlier = Number(item.snapItemLevel) <= partyMedian - 50;
    const markedFitsParty = bestDistance <= 40;
    const markedIsMuchCloser = exactDistance - bestDistance >= 50;
    if (!exactIsLowOutlier || !markedFitsParty || !markedIsMuchCloser) continue;

    corrections.push({ item, best, partyMedian });
  }

  for (const { item, best, partyMedian } of corrections) {
    console.log(
      `[listcheck] Party-level accent correction: "${item.name}" (${Number(item.snapItemLevel).toFixed(2)}) -> "${best.name}" (${Number(best.itemLevel).toFixed(2)}), median ${partyMedian.toFixed(2)}`
    );
    item.name = best.name;
    item.snapClassId = best.classId || '';
    item.snapClassName = best.classId ? getClassName(best.classId) : '';
    item.snapItemLevel = Number(best.itemLevel) || 0;
    item.snapCombatScore = best.combatScore || '';
  }
}
