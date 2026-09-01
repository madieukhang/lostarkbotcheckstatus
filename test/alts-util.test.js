import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeAltsByName } from '../bot/utils/alts.js';

test('mergeAltsByName dedupes case-insensitively and lets newer entries win', () => {
  const merged = mergeAltsByName(
    [
      { name: 'Aki', itemLevel: 1700 },
      { name: 'Bora', itemLevel: 1710 },
    ],
    [
      { name: 'aki', itemLevel: 1740 },
      { name: 'Ciel', itemLevel: 1720 },
    ]
  );

  assert.deepEqual(merged, [
    { name: 'aki', itemLevel: 1740 },
    { name: 'Bora', itemLevel: 1710 },
    { name: 'Ciel', itemLevel: 1720 },
  ]);
});

test('mergeAltsByName dedupes canonically equivalent Unicode names', () => {
  assert.deepEqual(
    mergeAltsByName(
      [{ name: 'Zoe\u0308', itemLevel: 1700 }],
      [{ name: 'Zoë', itemLevel: 1740 }],
    ),
    [{ name: 'Zoë', itemLevel: 1740 }],
  );
});
