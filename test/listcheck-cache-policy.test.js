import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldCacheRosterLookupResult } from '../bot/services/listCheckService.js';

test('list check roster cache only stores confirmed roster hits', () => {
  assert.equal(shouldCacheRosterLookupResult({
    hasValidRoster: true,
    allCharacters: ['Main', 'Alt'],
    failReason: null,
  }), true);

  assert.equal(shouldCacheRosterLookupResult({
    hasValidRoster: false,
    allCharacters: ['TypoName'],
    failReason: null,
  }), false);

  assert.equal(shouldCacheRosterLookupResult({
    hasValidRoster: false,
    allCharacters: ['BlockedName'],
    failReason: 'HTTP 403',
  }), false);
});
