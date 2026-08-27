import test from 'node:test';
import assert from 'node:assert/strict';

import { createExpiringSessionStore } from '../bot/utils/expiringSessionStore.js';

function createFakeTimers() {
  let nextId = 0;
  const active = new Map();
  return {
    active,
    setTimer(callback, delay) {
      const id = ++nextId;
      active.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      active.delete(id);
    },
  };
}

test('expiring session store shares create, touch, refresh, and clear lifecycle', () => {
  const timers = createFakeTimers();
  const store = createExpiringSessionStore({
    ttlMs: 300_000,
    createId: () => 'session-1',
    now: () => 1234,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const session = store.create({ value: 1 });
  assert.equal(session.sessionId, 'session-1');
  assert.equal(session.createdAt, 1234);
  assert.strictEqual(store.get('session-1'), session);
  assert.equal(timers.active.size, 1);

  const firstTimer = session.expireTimer;
  assert.strictEqual(store.touch('session-1'), session);
  assert.notEqual(session.expireTimer, firstTimer);
  assert.equal(timers.active.has(firstTimer), false);

  session.value = 2;
  assert.strictEqual(store.refresh(session), session);
  assert.equal(store.get('session-1').value, 2);
  assert.equal(timers.active.size, 1);

  store.clear('session-1');
  assert.equal(store.get('session-1'), null);
  assert.equal(timers.active.size, 0);
});

test('expiring session store removes only the session owned by the fired timer', () => {
  const timers = createFakeTimers();
  let id = 0;
  const store = createExpiringSessionStore({
    ttlMs: 100,
    createId: () => `session-${++id}`,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  const first = store.create({ value: 'first' });
  const second = store.create({ value: 'second' });
  timers.active.get(first.expireTimer).callback();

  assert.equal(store.get(first.sessionId), null);
  assert.strictEqual(store.get(second.sessionId), second);
  store.clear(second.sessionId);
});

test('expiring session store rejects invalid TTL configuration', () => {
  assert.throws(
    () => createExpiringSessionStore({ ttlMs: 0 }),
    /positive ttlMs/,
  );
});
