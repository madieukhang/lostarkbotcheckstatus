import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSystemHandlers,
  resolveSystemHealth,
} from '../bot/handlers/system/index.js';
import { STATUS } from '../bot/monitor/serverStatus.js';
import { COLORS } from '../bot/utils/ui.js';

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

const HEALTH_CASES = [
  {
    name: 'offline wins over maintenance',
    counts: { onlineCount: 1, offlineCount: 2, maintenanceCount: 3, unknownCount: 0, totalCount: 6 },
    expected: { state: 'offline', titleIcon: '🔴', color: COLORS.danger, count: 2 },
  },
  {
    name: 'maintenance is reported when no server is offline',
    counts: { onlineCount: 2, offlineCount: 0, maintenanceCount: 1, unknownCount: 0, totalCount: 3 },
    expected: { state: 'maintenance', titleIcon: '🟡', color: COLORS.warning, count: 1 },
  },
  {
    name: 'all known servers online is healthy',
    counts: { onlineCount: 3, offlineCount: 0, maintenanceCount: 0, unknownCount: 0, totalCount: 3 },
    expected: { state: 'online', titleIcon: '🟢', color: COLORS.success, count: 3 },
  },
  {
    name: 'mixed online and unknown state stays unknown',
    counts: { onlineCount: 2, offlineCount: 0, maintenanceCount: 0, unknownCount: 1, totalCount: 3 },
    expected: { state: 'unknown', titleIcon: '❓', color: COLORS.warning, count: 1 },
  },
  {
    name: 'empty status set is unknown rather than all-online',
    counts: { onlineCount: 0, offlineCount: 0, maintenanceCount: 0, unknownCount: 0, totalCount: 0 },
    expected: { state: 'unknown', titleIcon: '❓', color: COLORS.warning, count: 0 },
  },
];

for (const healthCase of HEALTH_CASES) {
  test(`system health classification: ${healthCase.name}`, () => {
    assert.deepEqual(resolveSystemHealth(healthCase.counts), healthCase.expected);
  });
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
