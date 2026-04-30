import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRosterCacheLookupMap,
  getRosterCacheMatch,
} from '../bot/services/rosterCacheLookup.js';
import RosterCache from '../bot/models/RosterCache.js';

test('buildRosterCacheLookupMap matches aliases from allCharacters', () => {
  const entry = {
    name: 'Mainchar',
    hasRoster: true,
    allCharacters: ['Mainchar', 'Altchar'],
    cachedAt: new Date('2026-04-30T00:00:00.000Z'),
  };
  const map = buildRosterCacheLookupMap([entry]);

  assert.equal(getRosterCacheMatch(map, 'altCHAR'), entry);
});

test('buildRosterCacheLookupMap prefers valid roster alias over exact no-roster miss', () => {
  const noRosterExact = {
    name: 'Altchar',
    hasRoster: false,
    allCharacters: [],
    cachedAt: new Date('2026-05-01T00:00:00.000Z'),
  };
  const rosterAlias = {
    name: 'Mainchar',
    hasRoster: true,
    allCharacters: ['Mainchar', 'Altchar'],
    cachedAt: new Date('2026-04-30T00:00:00.000Z'),
  };
  const map = buildRosterCacheLookupMap([noRosterExact, rosterAlias]);

  assert.equal(getRosterCacheMatch(map, 'Altchar'), rosterAlias);
});

test('RosterCache indexes allCharacters for roster alias cache lookup', () => {
  const indexes = RosterCache.schema.indexes();
  assert.ok(indexes.some(([fields]) => fields.allCharacters === 1));
});
