import test from 'node:test';
import assert from 'node:assert/strict';

import { startHeartbeat } from '../bot/services/worker/heartbeat.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('heartbeat skips interval fires while the previous Mongo write is pending', async () => {
  const first = deferred();
  let writes = 0;
  let intervalTick = null;
  const WorkerHeartbeat = {
    updateOne() {
      writes += 1;
      return writes === 1 ? first.promise : Promise.resolve();
    },
  };

  startHeartbeat({
    WorkerHeartbeat,
    setIntervalFn(callback) {
      intervalTick = callback;
      return { unref() {} };
    },
  });

  assert.equal(writes, 1);
  intervalTick();
  assert.equal(writes, 1);

  first.resolve();
  await first.promise;
  await new Promise((resolve) => setImmediate(resolve));
  intervalTick();
  assert.equal(writes, 2);
});
