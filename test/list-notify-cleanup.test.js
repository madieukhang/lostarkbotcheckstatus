import test from 'node:test';
import assert from 'node:assert/strict';

import {
  channelLifecycleGuard,
  createChannelLifecycleGuard,
} from '../bot/services/setup/channelLifecycleGuard.js';
import {
  createListNotifyCleanupScheduler,
  createListNotifyCleanupService,
  getVietnamHalfHourKey,
} from '../bot/services/setup/listNotifyCleanup.js';
import {
  LIST_NOTIFY_CLEANUP_NOTICE_TTL_MS,
  buildListNotifyCleanupNoticeEmbed,
  postListNotifyCleanupNotice,
  resolveListNotifyCleanupVolumeBucket,
} from '../bot/services/setup/listNotifyCleanupNotice.js';

function createConfig(overrides = {}) {
  return {
    guildId: 'guild-1',
    listNotifyChannelId: 'notify-1',
    listNotifyCleanupEnabled: true,
    listNotifyWelcomeMessageId: 'stored-welcome',
    ...overrides,
  };
}

test('channel lifecycle exposes one shared guard for same-channel setup flows', () => {
  assert.equal(typeof channelLifecycleGuard.runExclusive, 'function');
  assert.equal(typeof channelLifecycleGuard.getProtectedMessageIds, 'function');
});

test('notification cleanup cursor rolls on Vietnam half-hour boundaries', () => {
  assert.equal(getVietnamHalfHourKey(new Date('2026-08-30T00:29:59Z')), '2026-08-30T07:00');
  assert.equal(getVietnamHalfHourKey(new Date('2026-08-30T00:30:00Z')), '2026-08-30T07:30');
  assert.equal(getVietnamHalfHourKey(new Date('2026-08-30T16:59:59Z')), '2026-08-30T23:30');
  assert.equal(getVietnamHalfHourKey(new Date('2026-08-30T17:00:00Z')), '2026-08-31T00:00');
});

test('scheduled notify cleanup claims one slot, protects welcomes, refreshes, then posts notice', async () => {
  const config = createConfig();
  const updates = [];
  let claimed = false;
  const GuildConfigModel = {
    find(query) {
      assert.equal(query.listNotifyCleanupEnabled, true);
      assert.equal(query.lastListNotifyCleanupKey.$ne, '2026-08-30T07:30');
      return { lean: async () => [config] };
    },
    async findOneAndUpdate(query, update, options) {
      updates.push({ query, update, options });
      if (update.$set) {
        if (claimed) return null;
        claimed = true;
        return config;
      }
      return null;
    },
  };
  const guard = createChannelLifecycleGuard();
  guard.rememberWelcome('notify-1', 'fresh-in-flight');
  const events = [];
  let cleanupOptions;
  let welcomeOptions;
  const service = createListNotifyCleanupService({
    GuildConfigModel,
    channelGuard: guard,
    nowDate: () => new Date('2026-08-30T00:31:00Z'),
    resolveChannel: async () => ({ id: 'notify-1', guildId: 'guild-1' }),
    checkPermissions: () => ({ ok: true, missing: [] }),
    cleanupMessages: async (_channel, options) => {
      events.push('cleanup');
      cleanupOptions = options;
      return { deleted: 7, failed: 0, truncated: false };
    },
    postWelcomeLocked: async (options) => {
      events.push('welcome');
      welcomeOptions = options;
      return { pinned: true, persisted: true };
    },
    getGuildLanguageFn: async () => 'vi',
    postNotice: async (_channel, deleted, lang) => {
      events.push('notice:' + deleted + ':' + lang);
      return true;
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const client = { user: { id: 'bot-1' } };

  await service.runScheduledCleanupTick(client);
  await service.runScheduledCleanupTick(client);

  assert.deepEqual(events, ['cleanup', 'welcome', 'notice:7:vi']);
  assert.deepEqual(
    new Set(cleanupOptions.protectedMessageIds),
    new Set(['stored-welcome', 'fresh-in-flight'])
  );
  assert.equal(welcomeOptions.cleanupEnabled, true);
  assert.equal(welcomeOptions.botUserId, 'bot-1');
  assert.deepEqual(updates[0].update, {
    $set: { lastListNotifyCleanupKey: '2026-08-30T07:30' },
  });
});

test('failed scheduled cleanup releases its slot claim and does not refresh the guide', async () => {
  const config = createConfig();
  const updates = [];
  let welcomeCalls = 0;
  const service = createListNotifyCleanupService({
    GuildConfigModel: {
      find: () => ({ lean: async () => [config] }),
      async findOneAndUpdate(query, update) {
        updates.push({ query, update });
        return config;
      },
    },
    channelGuard: createChannelLifecycleGuard(),
    nowDate: () => new Date('2026-08-30T00:31:00Z'),
    resolveChannel: async () => ({ id: 'notify-1', guildId: 'guild-1' }),
    checkPermissions: () => ({ ok: true, missing: [] }),
    cleanupMessages: async () => ({
      deleted: 2,
      failed: 1,
      truncated: false,
      failureReasons: { '50013:Missing Permissions': 1 },
    }),
    postWelcomeLocked: async () => {
      welcomeCalls += 1;
      return { pinned: true, persisted: true };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.runScheduledCleanupTick({ user: { id: 'bot-1' } });

  assert.equal(welcomeCalls, 0);
  assert.deepEqual(updates[1], {
    query: {
      guildId: 'guild-1',
      lastListNotifyCleanupKey: '2026-08-30T07:30',
    },
    update: { $unset: { lastListNotifyCleanupKey: 1 } },
  });
});

test('scheduled cleanup does not claim a slot after Manage Messages is revoked', async () => {
  let updates = 0;
  let cleanupCalls = 0;
  const service = createListNotifyCleanupService({
    GuildConfigModel: {
      find: () => ({ lean: async () => [createConfig()] }),
      findOneAndUpdate: async () => { updates += 1; },
    },
    resolveChannel: async () => ({ id: 'notify-1', guildId: 'guild-1' }),
    checkPermissions: () => ({ ok: false, missing: ['Manage Messages'] }),
    cleanupMessages: async () => { cleanupCalls += 1; },
    logger: { info() {}, warn() {}, error() {} },
  });

  await service.runScheduledCleanupTick({ user: { id: 'bot-1' } });

  assert.equal(updates, 0);
  assert.equal(cleanupCalls, 0);
});

test('manual notify cleanup refreshes the guide without posting scheduler chatter', async () => {
  const events = [];
  let welcomeOptions;
  const service = createListNotifyCleanupService({
    GuildConfigModel: {},
    channelGuard: createChannelLifecycleGuard(),
    cleanupMessages: async () => {
      events.push('cleanup');
      return { deleted: 3, failed: 0, truncated: false };
    },
    postWelcomeLocked: async (options) => {
      events.push('welcome');
      welcomeOptions = options;
      return { pinned: true, persisted: true };
    },
    postNotice: async () => { events.push('notice'); },
  });

  const outcome = await service.cleanupAndRefreshListNotifyChannel(
    { id: 'notify-1' },
    {
      client: { user: { id: 'bot-1' } },
      guildId: 'guild-1',
      cleanupEnabled: false,
      postNoticeAfter: false,
    }
  );

  assert.equal(outcome.deleted, 3);
  assert.deepEqual(events, ['cleanup', 'welcome']);
  assert.equal(welcomeOptions.cleanupEnabled, false);
});

test('notification cleanup scheduler starts immediately, prevents overlap, and reuses one timer', async () => {
  let releaseFirst;
  let calls = 0;
  const cleanupService = {
    async runScheduledCleanupTick() {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
    },
  };
  let scheduled;
  const timer = { unref() {} };
  const scheduler = createListNotifyCleanupScheduler({
    cleanupService,
    setIntervalFn(callback, intervalMs) {
      assert.equal(intervalMs, 30 * 60 * 1000);
      scheduled = callback;
      return timer;
    },
    logger: { error() {} },
  });

  assert.strictEqual(scheduler.start({}), timer);
  await Promise.resolve();
  assert.equal(calls, 1);
  await scheduled();
  assert.equal(calls, 1);
  releaseFirst();
  await new Promise((resolve) => setImmediate(resolve));
  await scheduled();
  assert.equal(calls, 2);
  assert.strictEqual(scheduler.start({}), timer);
});

test('cleanup notice uses RaidManage volume buckets and self-deletes after five minutes', async () => {
  assert.equal(resolveListNotifyCleanupVolumeBucket(0), 'empty');
  assert.equal(resolveListNotifyCleanupVolumeBucket(5), 'trivial');
  assert.equal(resolveListNotifyCleanupVolumeBucket(6), 'normal');
  assert.equal(resolveListNotifyCleanupVolumeBucket(21), 'heavy');
  const embed = buildListNotifyCleanupNoticeEmbed(7, 'en', {
    translate: (_key, _lang, vars) => 'removed ' + vars.n,
  }).toJSON();
  assert.equal(embed.description, 'removed 7');

  let deleted = 0;
  let scheduled;
  let delay;
  const posted = await postListNotifyCleanupNotice(
    {
      send: async () => ({
        async delete() { deleted += 1; },
      }),
    },
    7,
    'en',
    {
      translate: (_key, _lang, vars) => 'removed ' + vars.n,
      setTimeoutFn(callback, ms) {
        scheduled = callback;
        delay = ms;
        return { unref() {} };
      },
    }
  );

  assert.equal(posted, true);
  assert.equal(delay, LIST_NOTIFY_CLEANUP_NOTICE_TTL_MS);
  scheduled();
  await Promise.resolve();
  assert.equal(deleted, 1);
});
