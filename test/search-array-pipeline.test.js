import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const {
  collectMissingSearchSnapshotNames,
  filterSearchSuggestions,
} = await import('../bot/handlers/search/index.js');

test('search filters and canonically dedupes suggestions in one stable pass', () => {
  const firstZoë = { name: 'Zoe\u0308', itemLevel: 1710, cls: 'bard' };
  const results = filterSearchSuggestions([
    firstZoë,
    { name: 'Zoë', itemLevel: 1720, cls: 'bard' },
    { name: 'Low', itemLevel: 1699, cls: 'bard' },
    { name: 'Wrongclass', itemLevel: 1750, cls: 'blade' },
    { name: 'Other', itemLevel: 1730, cls: 'bard' },
  ], {
    minIlvl: 1700,
    maxIlvl: 1740,
    classFilter: 'bard',
  });

  assert.deepEqual(results, [firstZoë, { name: 'Other', itemLevel: 1730, cls: 'bard' }]);
});

test('search collects only missing matched-entry snapshots with canonical dedupe', () => {
  const snapshotMap = new Map([['known', { name: 'Known' }]]);
  const zoë = { name: ' Zoe\u0308 ' };
  const known = { name: 'Known' };
  const another = { name: 'Another' };
  const names = collectMissingSearchSnapshotNames({
    black: new Map([['zoë', zoë], ['known', known]]),
    white: new Map([['zoë', zoë]]),
    watch: new Map([['another', another]]),
  }, ['Zoë', 'Known', 'Another'], snapshotMap);

  assert.deepEqual(names, ['Zoë', 'Another']);
});

test('search batches class snapshots only for the related names visible on the card', () => {
  const entry = {
    name: 'Main',
    allCharacters: ['Searched', 'Main', 'Zoë', 'Zoe\u0308', 'Knownalt', 'Thirdalt', 'Hiddenalt'],
  };
  const missing = collectMissingSearchSnapshotNames({
    black: new Map([['searched', entry]]),
    white: new Map(), watch: new Map(), trusted: new Map(),
  }, ['Searched'], new Map([['knownalt', { name: 'Knownalt', classId: 'bard' }]]));
  assert.deepEqual(missing, ['Main', 'Zoë', 'Thirdalt']);
});
