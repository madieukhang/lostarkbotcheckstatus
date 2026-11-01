import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  isInMaintenanceWindow,
  isInScheduledDowntime,
  needsRecoveryPolling,
  shouldRunScheduledCheck,
  startMonitor,
} from '../bot/monitor/monitor.js';
import { STATUS } from '../bot/monitor/serverStatus.js';
import config from '../bot/config.js';
import ServerMonitorStateModel from '../bot/models/ServerMonitorState.js';
import {
  finishOutageNotification,
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
    6
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

// Applies the subset of Mongo filter and update syntax stateStore uses, so a
// sequence of observations can be checked from start to end.
function memoryMonitorState() {
  const docs = new Map();
  const matchesValue = (value, cond) => {
    if (cond === null) return value == null;
    if (cond && typeof cond === 'object' && '$lte' in cond) return value != null && value <= cond.$lte;
    return value === cond;
  };
  const matches = (doc, filter) => Object.entries(filter).every(([key, cond]) => (
    key === '$or' ? cond.some((part) => matches(doc, part)) : matchesValue(doc[key], cond)
  ));
  const apply = (doc, update, inserted) => {
    Object.assign(doc, update.$set);
    if (inserted) Object.assign(doc, update.$setOnInsert);
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
  };
  return {
    docs,
    async findOneAndUpdate(filter, update, options = {}) {
      let doc = docs.get(filter.serverName);
      if (doc && !matches(doc, filter)) return null;
      const before = doc ? { ...doc } : null;
      if (!doc) {
        if (!options.upsert) return null;
        doc = { serverName: filter.serverName };
        docs.set(filter.serverName, doc);
      }
      apply(doc, update, before === null);
      return options.returnDocument === 'before' ? before : { ...doc };
    },
    async updateOne(filter, update) {
      const doc = docs.get(filter.serverName);
      if (!doc || !matches(doc, filter)) return { modifiedCount: 0 };
      apply(doc, update, false);
      return { modifiedCount: 1 };
    },
  };
}

const observeAt = (ServerMonitorState, status, { announceOutage = true, claimId } = {}) => observeServerStatus({
  server: 'Thaemine',
  status,
  announceOutage,
  ServerMonitorState,
  now: () => new Date('2026-11-02T03:00:00Z'),
  claimId,
});

test('an outage outside the schedule is announced once, from the second down read', async () => {
  const model = memoryMonitorState();
  await observeAt(model, STATUS.ONLINE);
  const first = await observeAt(model, STATUS.MAINTENANCE, { claimId: 'o1' });
  const second = await observeAt(model, STATUS.MAINTENANCE, { claimId: 'o2' });
  assert.equal(first.shouldNotifyOutage, false, 'one down read is not enough');
  assert.equal(second.shouldNotifyOutage, true);
  assert.equal(second.outageClaimId, 'o2');
  assert.equal(await finishOutageNotification({ server: 'Thaemine', claimId: 'o2', sent: true, ServerMonitorState: model }), true);

  // The page moving between no icon and the wrench is the same outage.
  assert.equal((await observeAt(model, STATUS.OFFLINE, { claimId: 'o3' })).shouldNotifyOutage, false);

  // Coming back still owes the usual recovery alert, and closes the outage.
  const back = await observeAt(model, STATUS.ONLINE, { claimId: 'r1' });
  assert.equal(back.shouldNotify, true);
  await finishRecoveryNotification({ server: 'Thaemine', claimId: 'r1', sent: true, ServerMonitorState: model });
  await observeAt(model, STATUS.OFFLINE, { claimId: 'o4' });
  assert.equal((await observeAt(model, STATUS.OFFLINE, { claimId: 'o5' })).shouldNotifyOutage, true, 'a later outage is a new one');
});

test('a downtime first seen inside the schedule is never announced, even past the window', async () => {
  const model = memoryMonitorState();
  await observeAt(model, STATUS.ONLINE);
  await observeAt(model, STATUS.MAINTENANCE, { announceOutage: false });
  await observeAt(model, STATUS.MAINTENANCE, { announceOutage: false });
  const pastWindow = await observeAt(model, STATUS.MAINTENANCE, { claimId: 'late' });
  assert.equal(pastWindow.shouldNotifyOutage, false);
});

test('a failed outage alert releases its claim so the next down read retries', async () => {
  const model = memoryMonitorState();
  await observeAt(model, STATUS.ONLINE);
  await observeAt(model, STATUS.OFFLINE, { claimId: 'o1' });
  await observeAt(model, STATUS.OFFLINE, { claimId: 'o2' });
  assert.equal(await finishOutageNotification({ server: 'Thaemine', claimId: 'o2', sent: false, ServerMonitorState: model }), true);
  const retry = await observeAt(model, STATUS.OFFLINE, { claimId: 'o3' });
  assert.equal(retry.shouldNotifyOutage, true);
  assert.equal(retry.outageClaimId, 'o3');
});

test('only one overlapping down observer wins the outage claim', async () => {
  const model = memoryMonitorState();
  await observeAt(model, STATUS.ONLINE);
  await observeAt(model, STATUS.OFFLINE, { claimId: 'o1' });
  const results = await Promise.all([
    observeAt(model, STATUS.OFFLINE, { claimId: 'a' }),
    observeAt(model, STATUS.OFFLINE, { claimId: 'b' }),
  ]);
  assert.equal(results.filter((entry) => entry.shouldNotifyOutage).length, 1);
});

test('scheduled downtime starts an hour before the weekly window and ends with it', () => {
  assert.equal(isInScheduledDowntime(new Date('2026-11-04T05:59:59Z')), false);
  assert.equal(isInScheduledDowntime(new Date('2026-11-04T06:00:00Z')), true);
  assert.equal(isInScheduledDowntime(new Date('2026-11-05T06:59:59Z')), true);
  assert.equal(isInScheduledDowntime(new Date('2026-11-05T07:00:00Z')), false);
  assert.equal(isInScheduledDowntime(new Date('2026-11-01T09:00:00Z')), false);
});

test('outside the weekly window the scheduler still checks every two minutes', () => {
  const sunday = new Date('2026-11-01T09:00:00Z');
  assert.equal(shouldRunScheduledCheck(sunday, false, sunday.getTime() - 60_000), false);
  assert.equal(shouldRunScheduledCheck(sunday, false, sunday.getTime() - 120_000), true);
  assert.equal(shouldRunScheduledCheck(new Date('2026-11-04T08:00:00Z'), false, Date.parse('2026-11-04T07:59:50Z')), true);
});

test('a downtime outside the schedule is announced once, then the recovery as usual', async t => {
  const at = Date.parse('2026-11-01T09:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  t.mock.method(console, 'log', () => {});
  const model = memoryMonitorState();
  t.mock.method(ServerMonitorStateModel, 'findOneAndUpdate', (...args) => model.findOneAndUpdate(...args));
  t.mock.method(ServerMonitorStateModel, 'updateOne', (...args) => model.updateOne(...args));
  let nextTick;
  t.mock.method(globalThis, 'setInterval', fn => { nextTick = fn; return { unref() {} }; });
  const statusClass = 'ags-ServerStatus-content-responses-response-server-status';
  const pages = {
    online: '<div aria-label="Thaemine is online">Thaemine</div>',
    wrench: `<div class="ags-ServerStatus-content-responses-response-server">
      <div class="${statusClass} ${statusClass}--maintenance"></div>
      <div class="ags-ServerStatus-content-responses-response-server-name" aria-label="Thaemine is offline">Thaemine</div>
    </div>`,
  };
  let page = 'online';
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return new Response(pages[page]);
  });
  const sent = [];
  const settle = async (done) => {
    for (let turn = 0; turn < 100 && !done(); turn += 1) await new Promise(resolve => setImmediate(resolve));
  };
  const tickAt = async (offsetMs, expectedFetches) => {
    t.mock.timers.setTime(at + offsetMs);
    nextTick();
    await settle(() => fetches >= expectedFetches && model.docs.get('Thaemine')?.lastCheckTime?.getTime() === at + offsetMs);
    await settle(() => false);
  };

  startMonitor({ channels: { fetch: async () => ({
    isTextBased: () => true, send: async (payload) => { sent.push(payload); },
  }) } });
  await settle(() => model.docs.get('Thaemine')?.lastStatus === STATUS.ONLINE);

  page = 'wrench';
  await tickAt(30_000, 1);
  assert.equal(fetches, 1, 'no check 30s after the last one outside the window');
  await tickAt(120_000, 2);
  assert.equal(sent.length, 0, 'a single down read announces nothing');
  await tickAt(150_000, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.title, /^🟡 /);
  assert.doesNotMatch(JSON.stringify(sent[0].embeds[0].data), /dialogue\./, 'every outage string resolves');
  assert.equal(sent[0].content, '@here');
  await tickAt(180_000, 4);
  assert.equal(sent.length, 1, 'the outage is announced once');

  page = 'online';
  await tickAt(210_000, 5);
  assert.equal(sent.length, 2);
  assert.match(sent[1].embeds[0].data.title, /^🟢 /);
});
