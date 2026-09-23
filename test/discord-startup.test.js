import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';

import {
  installDiscordGatewayDiagnostics,
  startDiscordLogin,
} from '../bot/app/discord-startup.js';

function createFakeTimers() {
  const active = new Map();
  let nextId = 0;

  return {
    active,
    setTimeoutFn(callback, delay) {
      const id = ++nextId;
      active.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) {
      active.delete(id);
    },
  };
}

function createGatewayHarness(options = {}) {
  const client = new EventEmitter();
  const timers = createFakeTimers();
  const errors = [];
  const warnings = [];
  const messages = [];
  const terminations = [];

  installDiscordGatewayDiagnostics(client, {
    terminate: async (payload) => {
      terminations.push(payload);
      return true;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: {
      error: (...parts) => errors.push(parts),
      warn: (...parts) => warnings.push(parts),
      log: (...parts) => messages.push(parts),
    },
    ...options,
  });

  return { client, timers, errors, warnings, messages, terminations };
}

test('Discord login clears its watchdog after becoming ready', async () => {
  const timers = createFakeTimers();
  const terminations = [];
  const messages = [];

  const result = await startDiscordLogin({
    client: { login: async (token) => assert.equal(token, 'token') },
    token: 'token',
    terminate: async (payload) => terminations.push(payload),
    timeoutMs: 45_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { log: (message) => messages.push(message) },
  });

  assert.equal(result, true);
  assert.deepEqual(terminations, []);
  assert.deepEqual(messages, ['[bot] Connecting to Discord gateway (timeout 45s)...']);
  assert.equal(timers.active.size, 0);
});

test('Discord login timeout terminates a silently pending gateway connection', async () => {
  const timers = createFakeTimers();
  const terminations = [];

  const login = startDiscordLogin({
    client: { login: () => new Promise(() => {}) },
    token: 'token',
    terminate: async (payload) => terminations.push(payload),
    timeoutMs: 60_000,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { log: () => {} },
  });

  const [{ callback, delay }] = timers.active.values();
  assert.equal(delay, 60_000);
  callback();

  assert.equal(await login, false);
  assert.deepEqual(terminations, [{
    label: 'Discord login timed out after 60s',
    error: null,
    exitCode: 1,
  }]);
  assert.equal(timers.active.size, 0);
});

test('Discord login rejection retains the original error for Railway logs', async () => {
  const timers = createFakeTimers();
  const error = new Error('invalid token');
  const terminations = [];

  const result = await startDiscordLogin({
    client: { login: async () => { throw error; } },
    token: 'token',
    terminate: async (payload) => terminations.push(payload),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    logger: { log: () => {} },
  });

  assert.equal(result, false);
  assert.deepEqual(terminations, [{
    label: 'Discord login failed',
    error,
    exitCode: 1,
  }]);
  assert.equal(timers.active.size, 0);
});

test('gateway diagnostics log shard errors, disconnects, and reconnects', () => {
  const { client, timers, errors, warnings } = createGatewayHarness();
  const error = new Error('socket reset');

  client.emit(Events.ShardError, error, 2);
  client.emit(Events.ShardDisconnect, { code: 1006 }, 2);
  client.emit(Events.ShardReconnecting, 2);

  assert.deepEqual(errors, [['[bot] Discord shard 2 error:', error]]);
  assert.deepEqual(warnings, [
    ['[bot] Discord shard 2 disconnected (code 1006).'],
    ['[bot] Discord shard 2 reconnecting...'],
  ]);
  assert.equal(timers.active.size, 1);
});

test('gateway diagnostics report successful resume and clear its watchdog', () => {
  const { client, timers, messages } = createGatewayHarness();

  client.emit(Events.ShardReconnecting, 0);
  client.emit(Events.ShardResume, 0, 4);

  assert.equal(timers.active.size, 0);
  assert.match(messages[0][0], /^\[bot\] Discord shard 0 resumed \(replayed 4 events\) in \d+ms\.$/);
});

test('gateway diagnostics report successful re-identify and clear its watchdog', () => {
  const { client, timers, messages } = createGatewayHarness();

  client.emit(Events.ShardReconnecting, 1);
  client.emit(Events.ShardReady, 1, new Set(['guild-1']));

  assert.equal(timers.active.size, 0);
  assert.match(
    messages[0][0],
    /^\[bot\] Discord shard 1 re-identified \(1 unavailable guilds\) in \d+ms\.$/,
  );
});

test('gateway reconnect watchdog keeps the first deadline and terminates a stuck shard', () => {
  const { client, timers, terminations, warnings } = createGatewayHarness({
    reconnectTimeoutMs: 120_000,
  });

  client.emit(Events.ShardReconnecting, 0);
  const [{ callback, delay }] = timers.active.values();
  client.emit(Events.ShardReconnecting, 0);

  assert.equal(delay, 120_000);
  assert.equal(timers.active.size, 1);
  assert.match(warnings[1][0], /^\[bot\] Discord shard 0 still reconnecting after \d+ms\.\.\.$/);

  callback();

  assert.deepEqual(terminations, [{
    label: 'Discord shard 0 reconnect timed out after 120s',
    exitCode: 1,
  }]);
  assert.equal(timers.active.size, 0);
});

test('gateway diagnostics reject invalid watchdog configuration', () => {
  assert.throws(
    () => installDiscordGatewayDiagnostics(new EventEmitter()),
    /require a terminator/,
  );
  assert.throws(
    () => installDiscordGatewayDiagnostics(new EventEmitter(), {
      terminate: async () => true,
      reconnectTimeoutMs: 0,
    }),
    /timeout must be a positive number/,
  );
});

test('Discord login rejects a non-positive watchdog configuration', async () => {
  await assert.rejects(
    startDiscordLogin({ timeoutMs: 0 }),
    /timeout must be a positive number/,
  );
});
