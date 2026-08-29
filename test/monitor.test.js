import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isInMaintenanceWindow,
  needsRecoveryPolling,
  recordServerStatus,
  resolvePersistedStatus,
  shouldRunScheduledCheck,
} from '../bot/monitor/monitor.js';
import { STATUS } from '../bot/monitor/serverStatus.js';

test('maintenance window ends at Thursday 07:00 UTC', () => {
  assert.equal(isInMaintenanceWindow(new Date('2026-08-27T06:59:59Z')), true);
  assert.equal(isInMaintenanceWindow(new Date('2026-08-27T07:00:00Z')), false);
});

test('unknown observations preserve the last definitive status', () => {
  assert.equal(resolvePersistedStatus(STATUS.MAINTENANCE, STATUS.UNKNOWN), STATUS.MAINTENANCE);
  assert.equal(resolvePersistedStatus(STATUS.OFFLINE, undefined), STATUS.OFFLINE);
  assert.equal(resolvePersistedStatus(null, STATUS.UNKNOWN), null);
});

test('maintenance to unknown to online still produces one recovery transition', () => {
  const state = { servers: {} };

  let outcome = recordServerStatus(state, 'Thaemine', STATUS.MAINTENANCE);
  assert.equal(outcome.shouldNotify, false);
  assert.equal(state.servers.Thaemine.lastStatus, STATUS.MAINTENANCE);

  outcome = recordServerStatus(state, 'Thaemine', STATUS.UNKNOWN);
  assert.equal(outcome.shouldNotify, false);
  assert.equal(state.servers.Thaemine.lastStatus, STATUS.MAINTENANCE);

  outcome = recordServerStatus(state, 'Thaemine', STATUS.ONLINE);
  assert.equal(outcome.shouldNotify, true);
  assert.equal(state.servers.Thaemine.lastStatus, STATUS.ONLINE);

  outcome = recordServerStatus(state, 'Thaemine', STATUS.ONLINE);
  assert.equal(outcome.shouldNotify, false);
});

test('an initial unknown observation does not become the initial or last status', () => {
  const state = { servers: {} };

  recordServerStatus(state, 'Thaemine', STATUS.UNKNOWN);

  assert.deepEqual(state.servers.Thaemine, {
    initialStatus: null,
    lastStatus: null,
    lastAlertTime: null,
  });
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
