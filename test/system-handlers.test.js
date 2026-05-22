import test from 'node:test';
import assert from 'node:assert/strict';

import { createSystemHandlers } from '../bot/handlers/system/index.js';
import { STATUS } from '../bot/monitor/serverStatus.js';

function createInteractionRecorder() {
  const calls = [];
  return {
    calls,
    interaction: {
      deferReply: async (...args) => calls.push({ method: 'deferReply', args }),
      editReply: async (payload) => calls.push({ method: 'editReply', payload }),
    },
  };
}

test('system status uses a public deferred embed reply', async () => {
  const { calls, interaction } = createInteractionRecorder();
  const handlers = createSystemHandlers({
    client: {},
    resetState: async () => {},
    checkStatus: async () => new Map([
      ['Azena', STATUS.ONLINE],
      ['Una', STATUS.MAINTENANCE],
    ]),
  });

  await handlers.handleStatusCommand(interaction);

  assert.deepEqual(calls[0], { method: 'deferReply', args: [] });
  assert.equal(calls[1].method, 'editReply');
  assert.equal(calls[1].payload.embeds.length, 1);
});

test('system reset uses the shared alert edit path after public defer', async () => {
  const { calls, interaction } = createInteractionRecorder();
  let resetCalled = false;
  const handlers = createSystemHandlers({
    client: {},
    checkStatus: async () => new Map(),
    resetState: async () => {
      resetCalled = true;
    },
  });

  await handlers.handleResetCommand(interaction);

  assert.equal(resetCalled, true);
  assert.deepEqual(calls[0], { method: 'deferReply', args: [] });
  assert.equal(calls[1].method, 'editReply');
  assert.equal(calls[1].payload.embeds.length, 1);
});
