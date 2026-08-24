import RosterSnapshot from '../../models/RosterSnapshot.js';
import { getClassName } from '../../models/Class.js';
import { hasAnyDiacritic, stripDiacritics } from './nameRecovery.js';

/**
 * Return the median after excluding one position from an already sorted
 * numeric array. The caller sorts once for the whole OCR batch, avoiding a
 * filter + sort for every candidate row.
 * @param {number[]} sortedValues - ascending item levels for the OCR batch
 * @param {number} excludedIndex - position to omit from the median
 * @returns {number|null} median of the remaining values, or null for bad input
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

/**
 * Find the sole snapshot closest to `targetLevel` in an item-level-sorted
 * list. Equal-distance neighbours and duplicate rows at the winning level
 * are deliberately rejected because the correction would be ambiguous.
 * @param {Array<{itemLevel: number|string}>} sortedSnapshots - ascending snapshots
 * @param {number} targetLevel - party median used to rank candidates
 * @returns {object|null} the unique nearest snapshot, or null when ambiguous
 */
export function findUniqueClosestSnapshot(sortedSnapshots, targetLevel) {
  if (!Array.isArray(sortedSnapshots) || sortedSnapshots.length === 0) return null;
  if (!Number.isFinite(targetLevel)) return null;

  let low = 0;
  let high = sortedSnapshots.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(sortedSnapshots[middle]?.itemLevel) < targetLevel) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const leftIndex = low - 1;
  const rightIndex = low;
  const leftDistance = leftIndex >= 0
    ? Math.abs(Number(sortedSnapshots[leftIndex].itemLevel) - targetLevel)
    : Number.POSITIVE_INFINITY;
  const rightDistance = rightIndex < sortedSnapshots.length
    ? Math.abs(Number(sortedSnapshots[rightIndex].itemLevel) - targetLevel)
    : Number.POSITIVE_INFINITY;

  if (leftDistance === rightDistance) return null;
  const bestIndex = leftDistance < rightDistance ? leftIndex : rightIndex;
  if (bestIndex < 0 || bestIndex >= sortedSnapshots.length) return null;

  const bestLevel = Number(sortedSnapshots[bestIndex].itemLevel);
  const previousLevel = bestIndex > 0
    ? Number(sortedSnapshots[bestIndex - 1].itemLevel)
    : null;
  const nextLevel = bestIndex + 1 < sortedSnapshots.length
    ? Number(sortedSnapshots[bestIndex + 1].itemLevel)
    : null;
  if (previousLevel === bestLevel || nextLevel === bestLevel) return null;

  return sortedSnapshots[bestIndex];
}

/**
 * Correct low OCR item-level outliers when one marked-name sibling uniquely
 * fits the immutable party median and all safety thresholds.
 * @param {Array<object>} results - mutable list-check result rows
 * @returns {Promise<void>}
 */
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
    if (
      !snap.classId
      || !hasAnyDiacritic(snap.name)
      || !Number.isFinite(Number(snap.itemLevel))
      || Number(snap.itemLevel) <= 0
    ) continue;
    if (!snapshotsByBase.has(base)) snapshotsByBase.set(base, []);
    snapshotsByBase.get(base).push(snap);
  }
  // Sort each normalized-name group once so every candidate can use binary
  // search while retaining the former duplicate-level and tie rejection rules.
  for (const snapshots of snapshotsByBase.values()) {
    snapshots.sort((a, b) => Number(a.itemLevel) - Number(b.itemLevel));
  }

  const corrections = [];
  for (const item of exactUnmarked) {
    const itemIndex = partyIndexByItem.get(item);
    const partyMedian = medianExcludingSortedIndex(sortedPartyLevels, itemIndex);
    if (!Number.isFinite(partyMedian)) continue;

    const base = stripDiacritics(item.name);
    const best = findUniqueClosestSnapshot(snapshotsByBase.get(base), partyMedian);
    if (!best) continue;
    const bestDistance = Math.abs(Number(best.itemLevel) - partyMedian);

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
