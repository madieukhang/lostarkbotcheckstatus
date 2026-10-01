import test from 'node:test';
import assert from 'node:assert/strict';
import GuildConfig from '../bot/models/GuildConfig.js';
import { getGuildConfig, invalidateGuildConfig } from '../bot/utils/scope.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('overlapping guild config reads share one Mongo query and cache its result', async (t) => {
  const gate = deferred();
  let reads = 0;
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: () => { reads++; return gate.promise; } }));
  t.after(() => invalidateGuildConfig('burst-guild'));
  const callers = Array.from({ length: 30 }, () => getGuildConfig('burst-guild'));
  const settings = { guildId: 'burst-guild', autoCheckChannelId: 'current' };
  gate.resolve(settings);
  assert.deepEqual(await Promise.all(callers), Array(30).fill(settings));
  assert.equal(await getGuildConfig('burst-guild'), settings);
  assert.equal(reads, 1);
});

test('missing guild configs are cached but become visible after setup invalidation', async (t) => {
  let settings = null;
  let reads = 0;
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => { reads++; return settings; } }));
  t.after(() => invalidateGuildConfig('missing-guild'));
  assert.equal(await getGuildConfig('missing-guild'), null);
  assert.equal(await getGuildConfig('missing-guild'), null);
  assert.equal(reads, 1);
  settings = { autoCheckChannelId: 'configured' };
  invalidateGuildConfig('missing-guild');
  assert.equal(await getGuildConfig('missing-guild'), settings);
  assert.equal(reads, 2);
});

test('invalidated reads join the newer read and cannot restore stale settings', async (t) => {
  const oldRead = deferred();
  const newRead = deferred();
  let reads = 0;
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: () => (++reads === 1 ? oldRead.promise : newRead.promise) }));
  t.after(() => invalidateGuildConfig('race-guild'));
  const oldCaller = getGuildConfig('race-guild');
  await Promise.resolve();
  invalidateGuildConfig('race-guild');
  const newCaller = getGuildConfig('race-guild');
  oldRead.resolve({ autoCheckChannelId: 'stale' });
  const settings = { autoCheckChannelId: 'fresh' };
  newRead.resolve(settings);
  assert.deepEqual(await Promise.all([oldCaller, newCaller]), [settings, settings]);
  assert.equal(await getGuildConfig('race-guild'), settings);
  assert.equal(reads, 2);
});

test('invalidation with no replacement caller reloads before returning', async (t) => {
  const oldRead = deferred();
  let reads = 0;
  const settings = { autoCheckChannelId: 'fresh' };
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => (++reads === 1 ? oldRead.promise : settings) }));
  t.after(() => invalidateGuildConfig('reload-guild'));
  const caller = getGuildConfig('reload-guild');
  await Promise.resolve();
  invalidateGuildConfig('reload-guild');
  oldRead.resolve({ autoCheckChannelId: 'stale' });
  assert.equal(await caller, settings);
  assert.equal(reads, 2);
});

test('failed shared reads remain retryable', async (t) => {
  let reads = 0;
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => {
    reads++;
    if (reads === 1) throw new Error('database offline');
    return { guildId: 'retry-guild' };
  } }));
  t.after(() => invalidateGuildConfig('retry-guild'));
  const failures = await Promise.allSettled([getGuildConfig('retry-guild'), getGuildConfig('retry-guild')]);
  assert.ok(failures.every(({ status, reason }) => status === 'rejected' && reason.message === 'database offline'));
  assert.deepEqual(await getGuildConfig('retry-guild'), { guildId: 'retry-guild' });
  assert.equal(reads, 2);
});

test('guild config cache bounds historic guilds and keeps recently read settings', async (t) => {
  const reads = new Map();
  t.mock.method(GuildConfig, 'findOne', ({ guildId }) => ({ lean: async () => {
    reads.set(guildId, (reads.get(guildId) || 0) + 1);
    return { guildId };
  } }));
  t.after(() => { for (let index = 0; index <= 256; index++) invalidateGuildConfig(`lru-${index}`); });
  for (let index = 0; index < 256; index++) await getGuildConfig(`lru-${index}`);
  await getGuildConfig('lru-0');
  await getGuildConfig('lru-256');
  await getGuildConfig('lru-0');
  await getGuildConfig('lru-1');
  assert.equal(reads.get('lru-0'), 1);
  assert.equal(reads.get('lru-1'), 2);
});

test('guild config TTL still refreshes settings after 60 seconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const scope = await import('../bot/utils/scope.js?ttl-test');
  let reads = 0;
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ revision: ++reads }) }));
  t.after(() => scope.invalidateGuildConfig('ttl-guild'));
  assert.deepEqual(await scope.getGuildConfig('ttl-guild'), { revision: 1 });
  t.mock.timers.tick(59_999);
  assert.deepEqual(await scope.getGuildConfig('ttl-guild'), { revision: 1 });
  t.mock.timers.tick(1);
  assert.deepEqual(await scope.getGuildConfig('ttl-guild'), { revision: 2 });
});
