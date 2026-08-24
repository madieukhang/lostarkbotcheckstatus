import test from 'node:test';
import assert from 'node:assert/strict';

import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import {
  applyMarkedSiblingLevelCorrections,
  findUniqueClosestSnapshot,
  medianExcludingSortedIndex,
} from '../bot/services/list-check/partyCorrections.js';

test('medianExcludingSortedIndex handles odd and even remaining batches', () => {
  const four = [10, 20, 30, 40];
  assert.equal(medianExcludingSortedIndex(four, 0), 30);
  assert.equal(medianExcludingSortedIndex(four, 1), 30);
  assert.equal(medianExcludingSortedIndex(four, 2), 20);
  assert.equal(medianExcludingSortedIndex(four, 3), 20);

  const five = [10, 20, 30, 40, 50];
  assert.equal(medianExcludingSortedIndex(five, 0), 35);
  assert.equal(medianExcludingSortedIndex(five, 2), 30);
  assert.equal(medianExcludingSortedIndex(five, 4), 25);
});

test('medianExcludingSortedIndex rejects unusable input', () => {
  assert.equal(medianExcludingSortedIndex([], 0), null);
  assert.equal(medianExcludingSortedIndex([10], 0), null);
  assert.equal(medianExcludingSortedIndex([10, 20], -1), null);
  assert.equal(medianExcludingSortedIndex([10, 20], 2), null);
});

test('findUniqueClosestSnapshot uses binary-search neighbours and rejects ties', () => {
  const snapshots = [
    { name: 'A', itemLevel: 1680 },
    { name: 'B', itemLevel: 1710 },
    { name: 'C', itemLevel: 1740 },
  ];
  assert.equal(findUniqueClosestSnapshot(snapshots, 1712)?.name, 'B');
  assert.equal(findUniqueClosestSnapshot(snapshots, 1725), null);
  assert.equal(findUniqueClosestSnapshot([], 1710), null);

  const duplicateLevel = [
    { name: 'A', itemLevel: 1700 },
    { name: 'B', itemLevel: 1710 },
    { name: 'C', itemLevel: 1710 },
  ];
  assert.equal(findUniqueClosestSnapshot(duplicateLevel, 1709), null);
});

test('findUniqueClosestSnapshot preserves the former linear selection rules', () => {
  function findWithLinearReference(snapshots, targetLevel) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestIsTied = false;
    for (const snapshot of snapshots) {
      const distance = Math.abs(Number(snapshot.itemLevel) - targetLevel);
      if (distance < bestDistance) {
        best = snapshot;
        bestDistance = distance;
        bestIsTied = false;
      } else if (distance === bestDistance) {
        bestIsTied = true;
      }
    }
    return best && !bestIsTied ? best : null;
  }

  // A deterministic generator covers duplicates, exact hits, midpoint ties,
  // and uneven gaps without making the regression test timing-dependent.
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  for (let sample = 0; sample < 500; sample += 1) {
    const snapshots = Array.from({ length: 1 + Math.floor(random() * 40) }, (_, index) => ({
      id: `${sample}:${index}`,
      itemLevel: 1500 + Math.floor(random() * 80) * 5,
    })).sort((a, b) => a.itemLevel - b.itemLevel);
    const targetLevel = 1480 + Math.floor(random() * 100) * 5;
    assert.equal(
      findUniqueClosestSnapshot(snapshots, targetLevel)?.id ?? null,
      findWithLinearReference(snapshots, targetLevel)?.id ?? null,
      `selection drifted for sample ${sample} at target ${targetLevel}`,
    );
  }
});

test('findUniqueClosestSnapshot reads logarithmically many rows', () => {
  let itemLevelReads = 0;
  const snapshots = Array.from({ length: 65_536 }, (_, index) => ({
    id: index,
    get itemLevel() {
      itemLevelReads += 1;
      return index * 10;
    },
  }));

  const match = findUniqueClosestSnapshot(snapshots, 327_681);

  assert.equal(match?.id, 32_768);
  assert.ok(itemLevelReads < 40, `expected logarithmic reads, received ${itemLevelReads}`);
});

test('party correction selects a unique accented sibling near the party median', async () => {
  const originalFind = RosterSnapshot.find;
  RosterSnapshot.find = () => ({
    collation: () => ({
      lean: async () => [{
        name: 'Bánana',
        itemLevel: 1710,
        classId: 'bard',
        combatScore: '90000',
      }],
    }),
  });

  const target = {
    name: 'Banana',
    snapItemLevel: 1500,
    snapClassId: 'berserker',
    snapClassName: 'Berserker',
    snapCombatScore: '10000',
  };
  const results = [
    target,
    { name: 'PartyA', snapItemLevel: 1700 },
    { name: 'PartyB', snapItemLevel: 1710 },
    { name: 'PartyC', snapItemLevel: 1720 },
  ];

  try {
    await applyMarkedSiblingLevelCorrections(results);
  } finally {
    RosterSnapshot.find = originalFind;
  }

  assert.deepEqual(target, {
    name: 'Bánana',
    snapItemLevel: 1710,
    snapClassId: 'bard',
    snapClassName: 'Bard',
    snapCombatScore: '90000',
  });
});

test('party corrections use one immutable level snapshot for the whole batch', async () => {
  const originalFind = RosterSnapshot.find;
  RosterSnapshot.find = () => ({
    collation: () => ({
      lean: async () => [
        { name: 'Bánana', itemLevel: 1650, classId: 'bard' },
        { name: 'Órange', itemLevel: 1675, classId: 'bard' },
      ],
    }),
  });

  const first = { name: 'Banana', snapItemLevel: 1300, snapClassId: 'berserker' };
  const second = { name: 'Orange', snapItemLevel: 1600, snapClassId: 'berserker' };
  const results = [
    first,
    second,
    { name: 'PartyA', snapItemLevel: 1500 },
    { name: 'PartyB', snapItemLevel: 1700 },
    { name: 'PartyC', snapItemLevel: 1700 },
  ];

  try {
    await applyMarkedSiblingLevelCorrections(results);
  } finally {
    RosterSnapshot.find = originalFind;
  }

  assert.equal(first.name, 'Bánana');
  assert.equal(first.snapItemLevel, 1650);
  assert.equal(
    second.name,
    'Orange',
    'the first correction must not move the median used by later rows'
  );
  assert.equal(second.snapItemLevel, 1600);
});
