import test from 'node:test';
import assert from 'node:assert/strict';

import { getWorkerHealth } from '../bot/services/worker/heartbeat.js';

// Minimal stand-in for the WorkerHeartbeat Mongoose model. Only what
// getWorkerHealth() actually calls: findOne(query).lean().
function buildFakeHeartbeat(doc) {
  return {
    findOne(query) {
      return {
        async lean() {
          if (!doc) return null;
          if (query.workerId && doc.workerId !== query.workerId) return null;
          return { ...doc };
        },
      };
    },
  };
}

test('getWorkerHealth reports offline when no heartbeat exists', async () => {
  const WorkerHeartbeat = buildFakeHeartbeat(null);
  const result = await getWorkerHealth({ WorkerHeartbeat });
  assert.equal(result.online, false);
  assert.equal(result.reason, 'no-heartbeat-record');
  assert.equal(result.lastSeenAt, null);
});

test('getWorkerHealth reports online for fresh heartbeat', async () => {
  const fixedNow = 10_000_000;
  const lastSeenAt = new Date(fixedNow - 5_000); // 5s old
  const WorkerHeartbeat = buildFakeHeartbeat({
    workerId: 'default',
    lastSeenAt,
    startedAt: new Date(fixedNow - 60_000),
  });

  const result = await getWorkerHealth({
    WorkerHeartbeat,
    maxStaleMs: 30_000,
    now: () => fixedNow,
  });
  assert.equal(result.online, true);
  assert.equal(result.reason, 'fresh');
  assert.equal(result.ageMs, 5_000);
});

test('getWorkerHealth reports offline when heartbeat is older than maxStaleMs', async () => {
  const fixedNow = 10_000_000;
  const lastSeenAt = new Date(fixedNow - 45_000); // 45s old
  const WorkerHeartbeat = buildFakeHeartbeat({
    workerId: 'default',
    lastSeenAt,
    startedAt: new Date(fixedNow - 120_000),
  });

  const result = await getWorkerHealth({
    WorkerHeartbeat,
    maxStaleMs: 30_000,
    now: () => fixedNow,
  });
  assert.equal(result.online, false);
  assert.equal(result.reason, 'stale-heartbeat');
  assert.equal(result.ageMs, 45_000);
});

test('getWorkerHealth respects custom workerId so multi-worker setups stay isolated', async () => {
  const WorkerHeartbeat = buildFakeHeartbeat({
    workerId: 'gpu-1',
    lastSeenAt: new Date(),
    startedAt: new Date(),
  });

  const matched = await getWorkerHealth({ WorkerHeartbeat, workerId: 'gpu-1', maxStaleMs: 60_000 });
  assert.equal(matched.online, true);

  const missed = await getWorkerHealth({ WorkerHeartbeat, workerId: 'gpu-2', maxStaleMs: 60_000 });
  assert.equal(missed.online, false);
  assert.equal(missed.reason, 'no-heartbeat-record');
});

test('getWorkerHealth boundary: heartbeat exactly maxStaleMs old still counts as online', async () => {
  const fixedNow = 10_000_000;
  const WorkerHeartbeat = buildFakeHeartbeat({
    workerId: 'default',
    lastSeenAt: new Date(fixedNow - 30_000),
    startedAt: new Date(fixedNow - 60_000),
  });

  const result = await getWorkerHealth({
    WorkerHeartbeat,
    maxStaleMs: 30_000,
    now: () => fixedNow,
  });
  assert.equal(result.online, true, 'boundary should be inclusive');
});
