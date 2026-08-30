import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createProcessTerminator,
  installProcessLifecycle,
} from '../bot/app/process-lifecycle.js';

test('fatal startup termination closes Discord and Mongo before exiting non-zero', async () => {
  const order = [];
  const terminate = createProcessTerminator({
    client: { destroy: async () => order.push('discord') },
    disconnect: async () => order.push('mongo'),
    exit: (code) => order.push(`exit:${code}`),
    logger: { error: () => order.push('log'), warn: () => {}, log: () => {} },
  });

  const first = await terminate({
    label: 'Ready bootstrap failed',
    error: new Error('mongo unavailable'),
    exitCode: 1,
  });
  const second = await terminate({ label: 'duplicate', exitCode: 1 });

  assert.equal(first, true);
  assert.equal(second, false);
  assert.deepEqual(order, ['log', 'discord', 'mongo', 'exit:1']);
});

test('SIGTERM is registered as a graceful zero-exit lifecycle event', async () => {
  const processRef = new EventEmitter();
  const calls = [];
  installProcessLifecycle({
    processRef,
    terminate: async (payload) => calls.push(payload),
  });

  processRef.emit('SIGTERM');
  await Promise.resolve();

  assert.deepEqual(calls, [{
    label: 'SIGTERM received, shutting down...',
    exitCode: 0,
  }]);
});
