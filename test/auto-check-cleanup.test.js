import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

import {
  cleanupAutoCheckChannelMessages,
  createAutoCheckCleanupScheduler,
  createAutoCheckCleanupService,
  getVietnamDayKey,
} from '../bot/services/setup/autoCheckCleanup.js';

function createMessage(id, { pinned = false, deleteError = null } = {}) {
  const state = { deleted: 0 };
  return {
    id,
    pinned,
    state,
    async delete() {
      if (deleteError) throw deleteError;
      state.deleted += 1;
    },
  };
}

function collectionOf(messages) {
  return new Collection(messages.map((message) => [message.id, message]));
}

test('Vietnam cleanup day rolls over at 00:00 Asia/Ho_Chi_Minh', () => {
  assert.equal(getVietnamDayKey(new Date('2026-07-09T16:59:59Z')), '2026-07-09');
  assert.equal(getVietnamDayKey(new Date('2026-07-09T17:00:00Z')), '2026-07-10');
});

test('daily cleanup paginates and deletes every non-pinned message', async () => {
  const firstPage = [];
  for (let index = 100; index >= 1; index -= 1) {
    firstPage.push(createMessage('m' + index, { pinned: index !== 100 }));
  }
  const oldOne = createMessage('old-1');
  const oldTwo = createMessage('old-2');
  const pages = [
    collectionOf(firstPage),
    collectionOf([oldOne, oldTwo]),
  ];
  const fetches = [];
  const channel = {
    messages: {
      async fetch(options) {
        fetches.push(options);
        return pages.shift() || new Collection();
      },
    },
  };

  const outcome = await cleanupAutoCheckChannelMessages(channel);

  assert.deepEqual(fetches, [
    { limit: 100 },
    { limit: 100, before: 'm1' },
  ]);
  assert.equal(outcome.deleted, 3);
  assert.equal(outcome.failed, 0);
  assert.equal(firstPage[0].state.deleted, 1);
  assert.equal(firstPage[1].state.deleted, 0);
  assert.equal(oldOne.state.deleted, 1);
  assert.equal(oldTwo.state.deleted, 1);
});

test('daily cleanup claims one VN day once even when the scheduler ticks again', async () => {
  const config = { guildId: 'guild-1', autoCheckChannelId: 'channel-1' };
  let claimed = false;
  const updates = [];
  const GuildConfigModel = {
    find() {
      return { lean: async () => [config] };
    },
    async findOneAndUpdate(query, update) {
      updates.push({ query, update });
      if (claimed) return null;
      claimed = true;
      return config;
    },
  };
  let cleanupCalls = 0;
  const service = createAutoCheckCleanupService({
    GuildConfigModel,
    cleanupMessages: async () => {
      cleanupCalls += 1;
      return { deleted: 4, failed: 0 };
    },
    nowDate: () => new Date('2026-07-09T17:05:00Z'),
    resolveChannel: async () => ({ id: 'channel-1', guildId: 'guild-1' }),
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.runDailyCleanupTick({});
  await service.runDailyCleanupTick({});

  assert.equal(cleanupCalls, 1);
  assert.equal(updates[0].query.lastAutoCheckCleanupKey.$ne, '2026-07-10');
  assert.deepEqual(updates[0].update, {
    $set: { lastAutoCheckCleanupKey: '2026-07-10' },
  });
});

test('daily cleanup releases the day claim when any deletion fails', async () => {
  const config = { guildId: 'guild-1', autoCheckChannelId: 'channel-1' };
  const updates = [];
  const GuildConfigModel = {
    find() {
      return { lean: async () => [config] };
    },
    async findOneAndUpdate(query, update) {
      updates.push({ query, update });
      if (update.$set) return config;
      return null;
    },
  };
  const service = createAutoCheckCleanupService({
    GuildConfigModel,
    cleanupMessages: async () => ({ deleted: 2, failed: 1 }),
    nowDate: () => new Date('2026-07-09T17:05:00Z'),
    resolveChannel: async () => ({ id: 'channel-1', guildId: 'guild-1' }),
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.runDailyCleanupTick({});

  assert.deepEqual(updates[1], {
    query: {
      guildId: 'guild-1',
      lastAutoCheckCleanupKey: '2026-07-10',
    },
    update: {
      $unset: { lastAutoCheckCleanupKey: 1 },
    },
  });
});

test('cleanup scheduler starts immediately, prevents overlap, and reuses one timer', async () => {
  let releaseFirst;
  let calls = 0;
  const cleanupService = {
    async runDailyCleanupTick() {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
    },
  };
  let scheduled = null;
  const timer = {
    unrefCalls: 0,
    unref() {
      this.unrefCalls += 1;
    },
  };
  const scheduler = createAutoCheckCleanupScheduler({
    cleanupService,
    setIntervalFn(callback, intervalMs) {
      assert.equal(intervalMs, 15 * 60 * 1000);
      scheduled = callback;
      return timer;
    },
    logger: { error() {} },
  });
  const client = { id: 'client' };

  assert.equal(scheduler.start(client), timer);
  await Promise.resolve();
  assert.equal(calls, 1);
  await scheduled();
  assert.equal(calls, 1);

  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduled();
  assert.equal(calls, 2);
  assert.equal(scheduler.start(client), timer);
  assert.equal(timer.unrefCalls, 1);
});
