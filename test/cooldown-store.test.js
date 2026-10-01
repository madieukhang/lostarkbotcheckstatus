import test from 'node:test';
import assert from 'node:assert/strict';
import { createCooldownStore } from '../bot/utils/cooldownStore.js';

test('cooldowns release all expired keys without reads or evicting active users', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const store = createCooldownStore(10_000, { now: Date.now });
  t.after(() => store.clear());
  for (let index = 0; index < 2000; index++) store.mark(`user-${index}`);
  assert.equal(store.size, 2000);
  assert.equal(store.remainingMs('user-0'), 10_000);
  t.mock.timers.tick(10_000);
  assert.equal(store.size, 0);
  assert.equal(store.remainingMs('user-0'), 0);
});

test('remarking a key preserves its newer cooldown when the first deadline expires', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const store = createCooldownStore(10_000, { now: Date.now });
  t.after(() => store.clear());
  store.mark('active');
  store.mark('expired');
  t.mock.timers.tick(5000);
  store.mark('active');
  t.mock.timers.tick(5000);
  assert.equal(store.size, 1);
  assert.equal(store.remainingMs('active'), 5000);
  t.mock.timers.tick(5000);
  assert.equal(store.size, 0);
});

test('clearing a cooldown store cancels old expiry and allows a fresh timer', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const store = createCooldownStore(10_000, { now: Date.now });
  t.after(() => store.clear());
  store.mark('old');
  t.mock.timers.tick(5000);
  store.clear();
  store.mark('new');
  t.mock.timers.tick(5000);
  assert.equal(store.size, 1);
  assert.equal(store.remainingMs('new'), 5000);
  t.mock.timers.tick(5000);
  assert.equal(store.size, 0);
});

test('staggered cooldown expiry does not rescan the entire active store', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const store = createCooldownStore(10_000, { now: Date.now });
  t.after(() => store.clear());
  const count = 500;
  for (let index = 0; index < count; index++) {
    store.mark(`expiry-${index}`);
    t.mock.timers.tick(1);
  }
  let visited = 0;
  const iterate = Map.prototype[Symbol.iterator];
  t.mock.method(Map.prototype, Symbol.iterator, function* () {
    for (const entry of iterate.call(this)) {
      if (typeof entry[0] === 'string' && entry[0].startsWith('expiry-')) visited++;
      yield entry;
    }
  });
  t.mock.timers.tick(10_000 - count - 1);
  for (let index = 0; index < count; index++) t.mock.timers.tick(1);
  assert.equal(store.size, 0);
  assert.ok(visited <= 2 * count, `expiry visited ${visited} keys for ${count} cooldowns`);
});
