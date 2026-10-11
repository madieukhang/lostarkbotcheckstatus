import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isInMaintenanceWindow,
  needsRecoveryPolling,
  shouldRunScheduledCheck,
  startMonitor,
} from '../bot/monitor/monitor.js';
import { STATUS } from '../bot/monitor/serverStatus.js';
import config from '../bot/config.js';
import ServerMonitorStateModel from '../bot/models/ServerMonitorState.js';
import {
  finishRecoveryNotification,
  observeServerStatus,
} from '../bot/monitor/stateStore.js';

test('maintenance window ends at Thursday 07:00 UTC', () => {
  assert.equal(isInMaintenanceWindow(new Date('2026-08-27T06:59:59Z')), true);
  assert.equal(isInMaintenanceWindow(new Date('2026-08-27T07:00:00Z')), false);
});

test('server monitor is hard-locked to Thaemine', () => {
  assert.deepEqual(config.targetServers, ['Thaemine']);
  assert.equal(Object.isFrozen(config.targetServers), true);
});

test('unknown observations update only the check time and preserve the last status', async () => {
  const calls = [];
  const observedAt = new Date('2026-08-27T13:54:23Z');
  const ServerMonitorState = {
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return { lastStatus: STATUS.MAINTENANCE };
    },
  };

  const result = await observeServerStatus({
    server: 'Thaemine',
    status: STATUS.UNKNOWN,
    ServerMonitorState,
    now: () => observedAt,
  });

  assert.equal(result.previousStatus, STATUS.MAINTENANCE);
  assert.equal(result.shouldNotify, false);
  assert.deepEqual(calls[0].update.$set, { lastCheckTime: observedAt });
  assert.equal(Object.hasOwn(calls[0].update.$set, 'lastStatus'), false);
});

test('down observations persist recoveryPending and clear stale alert claims', async () => {
  const calls = [];
  const ServerMonitorState = {
    async findOneAndUpdate(filter, update, options) {
      calls.push({ filter, update, options });
      return { lastStatus: STATUS.ONLINE };
    },
  };

  const result = await observeServerStatus({
    server: 'Thaemine',
    status: STATUS.MAINTENANCE,
    ServerMonitorState,
  });

  assert.equal(result.previousStatus, STATUS.ONLINE);
  assert.equal(result.shouldNotify, false);
  assert.equal(calls[0].update.$set.lastStatus, STATUS.MAINTENANCE);
  assert.equal(calls[0].update.$set.recoveryPending, true);
  assert.deepEqual(calls[0].update.$unset, { alertClaimId: '', alertClaimUntil: '' });
  assert.deepEqual(calls[0].options, {
    upsert: true,
    returnDocument: 'before',
  });
});

test('monitor state writes use the current Mongoose returnDocument option', () => {
  const source = readFileSync(
    new URL('../bot/monitor/stateStore.js', import.meta.url),
    'utf8'
  );

  assert.doesNotMatch(source, /\bnew\s*:/);
  assert.equal(
    [...source.matchAll(/returnDocument:\s*['"]before['"]/g)].length,
    4
  );
});

test('only one overlapping online observer wins the recovery claim', async () => {
  let claimCalls = 0;
  const ServerMonitorState = {
    async findOneAndUpdate(filter) {
      if (filter.recoveryPending === true) {
        claimCalls += 1;
        return claimCalls === 1 ? { lastStatus: STATUS.MAINTENANCE } : null;
      }
      return { lastStatus: STATUS.ONLINE };
    },
  };

  const results = await Promise.all([
    observeServerStatus({
      server: 'Thaemine',
      status: STATUS.ONLINE,
      ServerMonitorState,
      claimId: 'claim-a',
    }),
    observeServerStatus({
      server: 'Thaemine',
      status: STATUS.ONLINE,
      ServerMonitorState,
      claimId: 'claim-b',
    }),
  ]);

  assert.equal(results.filter((entry) => entry.shouldNotify).length, 1);
  assert.equal(results.find((entry) => entry.shouldNotify).claimId, 'claim-a');
});

test('an online observation that cannot claim a pending recovery reports the delivery as still pending', async () => {
  const observe = recoveryPending => observeServerStatus({
    server: 'Thaemine',
    status: STATUS.ONLINE,
    ServerMonitorState: {
      // Another worker's live lease makes the claim filter miss.
      async findOneAndUpdate(filter) {
        return filter.recoveryPending === true ? null : { lastStatus: STATUS.ONLINE, recoveryPending };
      },
    },
  });

  const pending = await observe(true);
  assert.equal(pending.shouldNotify, false);
  assert.equal(pending.deliveryPending, true);
  assert.equal((await observe(false)).deliveryPending, false);
});

test('a restart outside maintenance keeps polling until a dead worker\'s recovery claim can be retried', async t => {
  const at = Date.parse('2026-10-09T09:00:00Z');
  assert.equal(isInMaintenanceWindow(new Date(at)), false);
  t.mock.timers.enable({ apis: ['Date'], now: at });
  t.mock.method(console, 'log', () => {});
  let nextTick;
  let fetches = 0;
  let notifications = 0;
  const state = { lastStatus: 'online', recoveryPending: true, alertClaimUntil: new Date(at + 60_000), alertClaimId: 'dead-worker' };
  let initialDone;
  const initialObservation = new Promise(resolve => { initialDone = resolve; });
  t.mock.method(globalThis, 'setInterval', fn => { nextTick = fn; return { unref() {} }; });
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return new Response('<div aria-label="Thaemine is online">Thaemine</div>');
  });
  t.mock.method(ServerMonitorStateModel, 'findOneAndUpdate', async (filter, update) => {
    if (filter.recoveryPending === true && state.alertClaimUntil > new Date()) return null;
    const before = { ...state };
    Object.assign(state, update.$set);
    if (!filter.recoveryPending) initialDone();
    return before;
  });
  t.mock.method(ServerMonitorStateModel, 'updateOne', async (_filter, update) => {
    Object.assign(state, update.$set);
    for (const key of Object.keys(update.$unset || {})) delete state[key];
    return { modifiedCount: 1 };
  });
  startMonitor({ channels: { fetch: async () => ({
    isTextBased: () => true, send: async () => { notifications += 1; },
  }) } });
  await initialObservation;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches, 1);

  t.mock.timers.setTime(at + 3 * 60_000);
  nextTick();
  for (let turn = 0; turn < 50 && notifications === 0; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(fetches, 2, 'the scheduler polls again after the orphaned lease expires');
  assert.equal(notifications, 1);
  assert.equal(state.recoveryPending, false);
});

test('failed recovery delivery releases its claim for a later retry', async () => {
  const calls = [];
  const ServerMonitorState = {
    async updateOne(filter, update) {
      calls.push({ filter, update });
      return { modifiedCount: 1 };
    },
  };

  const finished = await finishRecoveryNotification({
    server: 'Thaemine',
    claimId: 'claim-a',
    sent: false,
    ServerMonitorState,
  });

  assert.equal(finished, true);
  assert.deepEqual(calls[0].filter, {
    serverName: 'Thaemine',
    alertClaimId: 'claim-a',
  });
  assert.equal(calls[0].update.$set.recoveryPending, true);
  assert.deepEqual(calls[0].update.$unset, { alertClaimId: '', alertClaimUntil: '' });
});

test('recovery polling stays active until every server is online', () => {
  assert.equal(needsRecoveryPolling(new Map()), true);
  assert.equal(needsRecoveryPolling(new Map([['Thaemine', STATUS.UNKNOWN]])), true);
  assert.equal(needsRecoveryPolling(new Map([['Thaemine', STATUS.MAINTENANCE]])), true);
  assert.equal(needsRecoveryPolling(new Map([['Thaemine', STATUS.OFFLINE]])), true);
  assert.equal(needsRecoveryPolling(new Map([
    ['Thaemine', STATUS.ONLINE],
    ['Inanna', STATUS.UNKNOWN],
  ])), true);
  assert.equal(needsRecoveryPolling(new Map([
    ['Thaemine', STATUS.ONLINE],
    ['Inanna', STATUS.ONLINE],
  ])), false);
});

test('recovery polling crosses the fixed maintenance-window boundary', () => {
  const afterWindow = new Date('2026-08-27T07:00:00Z');

  assert.equal(shouldRunScheduledCheck(afterWindow, false), false);
  assert.equal(shouldRunScheduledCheck(afterWindow, true), true);
});
