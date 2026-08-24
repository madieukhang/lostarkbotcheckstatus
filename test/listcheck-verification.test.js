import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasDatabaseListMatch,
  isCharacterIdentityVerified,
  partitionListCheckResultsByVerification,
} from '../bot/services/list-check/verification.js';

test('identity verification rejects unresolved external candidates', () => {
  assert.equal(hasDatabaseListMatch({ name: 'Ocrnoise' }), false);
  assert.equal(isCharacterIdentityVerified({ name: 'Ocrnoise' }), false);
});

test('identity verification accepts Bible, snapshot, and Mongo list proof', () => {
  assert.equal(isCharacterIdentityVerified({
    name: 'Biblecharacter',
    identityVerified: true,
  }), true);
  assert.equal(isCharacterIdentityVerified({
    name: 'Storedcharacter',
    blackEntry: { name: 'Storedcharacter' },
  }), true);
  assert.equal(hasDatabaseListMatch({
    name: 'Searchresult',
    trusted: { name: 'Searchresult' },
  }), true);
});

test('identity verification partition preserves source order', () => {
  const verifiedByBible = { name: 'First', identityVerified: true };
  const unverified = { name: 'Second' };
  const verifiedByList = { name: 'Third', watchEntry: { name: 'Third' } };

  assert.deepEqual(
    partitionListCheckResultsByVerification([
      verifiedByBible,
      unverified,
      verifiedByList,
    ]),
    {
      verified: [verifiedByBible, verifiedByList],
      unverified: [unverified],
    },
  );
});
