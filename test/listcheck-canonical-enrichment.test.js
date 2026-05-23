import test from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.BIBLE_WORKER_ENABLED = 'false';

let mongod;
let checkNamesAgainstLists;
let formatCheckResults;
let connectDB;
let RosterSnapshot;
let WorkerHeartbeat;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();

  ({ connectDB } = await import('../bot/db.js'));
  ({ checkNamesAgainstLists, formatCheckResults } = await import('../bot/services/list-check/service.js'));
  ({ default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js'));
  ({ default: WorkerHeartbeat } = await import('../bot/models/WorkerHeartbeat.js'));

  await connectDB();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    RosterSnapshot.deleteMany({}),
    WorkerHeartbeat.deleteMany({}),
  ]);
});

async function markWorkerOnline() {
  await WorkerHeartbeat.create({
    workerId: 'default',
    lastSeenAt: new Date(),
    startedAt: new Date(),
    pid: 12345,
  });
}

function installBibleSearchStub() {
  const originalFetch = globalThis.fetch;
  const counts = { rosterCalls: 0, searchCalls: 0 };

  globalThis.fetch = async (url) => {
    const requestedUrl = String(url);

    if (requestedUrl.includes('/character/NA/')) {
      counts.rosterCalls += 1;
      return new Response('<html><body>No roster here</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }

    if (requestedUrl.includes('/_app/remote/ngsbie/search')) {
      counts.searchCalls += 1;
      const data = [[1], [2, 3, 4], 'Qyoir', 'bard', 1741.67];
      return Response.json({
        type: 'result',
        result: JSON.stringify(data),
      });
    }

    throw new Error(`unexpected URL: ${requestedUrl}`);
  };

  return {
    counts,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test('worker-online enrichment falls back to bible search canonical names', async () => {
  await markWorkerOnline();
  const stub = installBibleSearchStub();

  try {
    const results = await checkNamesAgainstLists(['Qy\u00F6ir'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Qyoir');
    assert.equal(results[0].snapClassName, 'Bard');
    assert.equal(results[0].snapItemLevel, 1741.67);
    assert.match(lines[0], /Qyoir/);
    assert.doesNotMatch(lines[0], /Qy\u00F6ir/);
    assert.equal(stub.counts.rosterCalls, 1);
    assert.equal(stub.counts.searchCalls, 1);

    const snapshot = await RosterSnapshot.findOne({ name: 'Qyoir' }).lean();
    assert.equal(snapshot?.itemLevel, 1741.67);
    assert.equal(snapshot?.classId, 'bard');
  } finally {
    stub.restore();
  }
});

test('worker-online canonicalization repairs short i/l look-alike names', async () => {
  await markWorkerOnline();
  const stub = installBibleSearchStub();

  try {
    const results = await checkNamesAgainstLists(['Qyolr'], { guildId: 'guild-1' });
    const lines = formatCheckResults(results);

    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'Qyoir');
    assert.equal(results[0].snapClassName, 'Bard');
    assert.equal(results[0].snapItemLevel, 1741.67);
    assert.match(lines[0], /Qyoir/);
    assert.doesNotMatch(lines[0], /Qyolr/);
    assert.equal(stub.counts.rosterCalls, 1);
    assert.equal(stub.counts.searchCalls, 1);
  } finally {
    stub.restore();
  }
});
