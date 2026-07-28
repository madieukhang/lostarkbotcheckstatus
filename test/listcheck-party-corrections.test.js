import test from 'node:test';
import assert from 'node:assert/strict';

import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import {
  applyMarkedSiblingLevelCorrections,
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
