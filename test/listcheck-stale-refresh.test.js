import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.BIBLE_WORKER_ENABLED = 'false';
process.env.SCRAPERAPI_KEY = '';
process.env.SCRAPERAPI_KEY_2 = '';
process.env.SCRAPERAPI_KEY_3 = '';

const { enrichListCheckResults } = await import('../bot/services/list-check/enrichment.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { default: WorkerHeartbeat } = await import('../bot/models/WorkerHeartbeat.js');

const DAY_MS = 24 * 60 * 60 * 1000;

// A checked name whose class and item level came from a snapshot of the given age.
const checkedName = (name, ageDays, itemLevel = 1725) => ({
  name,
  identityVerified: true,
  identityVerificationSource: 'roster-snapshot',
  snapClassId: 'bard',
  snapClassName: 'Bard',
  snapItemLevel: itemLevel,
  snapCombatScore: '4100',
  snapUpdatedAt: new Date(Date.now() - ageDays * DAY_MS),
  discoveredAlts: [],
});

// Bible's name search answers from `hits` (queried name -> one suggestion);
// the worker is offline, so the search route is the one in use.
function mockBible(t, hits = {}) {
  clearNameSuggestionCache();
  t.after(clearNameSuggestionCache);
  t.mock.method(WorkerHeartbeat, 'findOne', () => ({ lean: async () => null }));
  const queried = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const payload = new URL(String(url)).searchParams.get('payload');
    const name = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))[1];
    queried.push(name);
    const hit = hits[name];
    const data = hit ? [[1], [2, 3, 4], hit.name, hit.cls, hit.itemLevel] : [[]];
    return Response.json({ type: 'result', result: JSON.stringify(data) });
  });
  const writes = [];
  t.mock.method(RosterSnapshot, 'bulkWrite', async (operations) => {
    writes.push(...operations.map((operation) => ({
      name: operation.updateOne.filter.name,
      ...operation.updateOne.update.$set,
    })));
    return {};
  });
  return { queried, writes };
}

test('a check refreshes a snapshot older than a week and keeps the name', async (t) => {
  const { writes } = mockBible(t, { Shawlion: { name: 'Shawlion', cls: 'bard', itemLevel: 1755 } });
  const item = checkedName('Shawlion', 10);
  await enrichListCheckResults([item]);
  assert.equal(item.name, 'Shawlion');
  assert.equal(item.snapItemLevel, 1755);
  assert.equal(item.identityVerificationSource, 'roster-snapshot');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, 'Shawlion');
  assert.equal(writes[0].itemLevel, 1755);
  assert.equal(writes[0].classId, 'bard');
});

test('a check leaves a snapshot from this week alone', async (t) => {
  const { queried, writes } = mockBible(t);
  await enrichListCheckResults([checkedName('Shawlion', 2)]);
  assert.deepEqual(queried, []);
  assert.deepEqual(writes, []);
});

test('a stale refresh never renames a character to a near match', async (t) => {
  mockBible(t, { Shawlion: { name: 'Shawlions', cls: 'bard', itemLevel: 1760 } });
  const item = checkedName('Shawlion', 10);
  await enrichListCheckResults([item]);
  assert.equal(item.name, 'Shawlion');
  assert.equal(item.snapItemLevel, 1725);
});

test('a check refreshes at most three stale names, the oldest first', async (t) => {
  const { queried } = mockBible(t);
  const items = [10, 50, 20, 40, 30].map((age) => checkedName(`Stale${age}`, age));
  await enrichListCheckResults(items);
  assert.deepEqual(queried.sort(), ['Stale30', 'Stale40', 'Stale50']);
});

test('a check refreshes stale names alongside the names it resolves', async (t) => {
  mockBible(t, {
    Newname: { name: 'Newname', cls: 'bard', itemLevel: 1740 },
    Shawlion: { name: 'Shawlion', cls: 'bard', itemLevel: 1755 },
  });
  const fresh = { name: 'Newname', snapClassId: '', snapClassName: '', snapItemLevel: 0, snapCombatScore: '', discoveredAlts: [] };
  const stale = checkedName('Shawlion', 10);
  await enrichListCheckResults([fresh, stale]);
  assert.equal(fresh.snapItemLevel, 1740);
  assert.equal(stale.snapItemLevel, 1755);
});
