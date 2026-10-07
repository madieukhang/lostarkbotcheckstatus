import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = 'senior-1';

const { createSystemHandlers, resolveSystemHealth } = await import('../bot/handlers/system/index.js');
const { STATUS } = await import('../bot/monitor/serverStatus.js');
const { COLORS } = await import('../bot/utils/ui.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');

function createInteractionRecorder(userId) {
  const calls = [];
  return {
    calls,
    interaction: {
      ...(userId ? { user: { id: userId } } : {}),
      deferReply: async (...args) => calls.push({ method: 'deferReply', args }),
      editReply: async (payload) => calls.push({ method: 'editReply', payload }),
    },
  };
}

function mockEnglishPreference(t) {
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
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

test('system status uses a public deferred embed reply', async (t) => {
  mockEnglishPreference(t);
  const { calls, interaction } = createInteractionRecorder('anyone-1');
  const handlers = createSystemHandlers({
    client: {},
    connectDBFn: async () => {},
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
  // The headline already carries the count, so the fields list servers only.
  assert.deepEqual(
    calls[1].payload.embeds[0].toJSON().fields.map((field) => field.name),
    ['🟡 Una', '🟢 Azena'],
  );
});

test('system reset uses the shared alert edit path after public defer', async (t) => {
  mockEnglishPreference(t);
  const { calls, interaction } = createInteractionRecorder('senior-1');
  let resetCalled = false;
  const handlers = createSystemHandlers({
    client: {},
    connectDBFn: async () => {},
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

test('system reset is senior-only: strangers never reach resetState', async (t) => {
  mockEnglishPreference(t);
  const { calls, interaction } = createInteractionRecorder('stranger-1');
  let resetCalled = false;
  const handlers = createSystemHandlers({
    client: {},
    connectDBFn: async () => {},
    checkStatus: async () => new Map(),
    resetState: async () => {
      resetCalled = true;
    },
  });

  await handlers.handleResetCommand(interaction);

  assert.equal(resetCalled, false);
  assert.deepEqual(calls[0], { method: 'deferReply', args: [] });
  assert.equal(calls[1].method, 'editReply');
  assert.equal(calls[1].payload.embeds.length, 1);
});

test('system handlers re-establish the DB connection before doing work', async (t) => {
  mockEnglishPreference(t);
  const order = [];
  const handlers = createSystemHandlers({
    client: {},
    connectDBFn: async () => { order.push('connect'); },
    resetState: async () => { order.push('reset'); },
    checkStatus: async () => { order.push('check'); return new Map(); },
  });

  await handlers.handleResetCommand(createInteractionRecorder('senior-1').interaction);
  await handlers.handleStatusCommand(createInteractionRecorder('senior-1').interaction);

  assert.deepEqual(order, ['connect', 'reset', 'connect', 'check']);
});
