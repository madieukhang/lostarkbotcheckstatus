import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoCheckWelcomeEmbed,
  createAutoCheckWelcomeService,
} from '../bot/services/setup/autoCheckWelcome.js';
import { createAutoCheckCleanupService } from '../bot/services/setup/autoCheckCleanup.js';
import { createAutoCheckChannelGuard } from '../bot/services/setup/autoCheckChannelGuard.js';

function fakeEmbed(title) {
  return {
    toJSON: () => ({ title }),
  };
}

function createMessage(id, title, { authorId = 'bot' } = {}) {
  const state = { deleted: 0, pinned: 0, unpinned: 0 };
  return {
    id,
    author: { id: authorId },
    embeds: [{ title }],
    state,
    async delete() {
      state.deleted += 1;
    },
    async pin() {
      state.pinned += 1;
    },
    async unpin() {
      state.unpinned += 1;
    },
  };
}

function createGuildConfig({ stored = null, persistError = null } = {}) {
  const updates = [];
  return {
    updates,
    findOne() {
      return {
        lean: async () => stored,
      };
    },
    async findOneAndUpdate(query, update, options) {
      updates.push({ query, update, options });
      if (persistError) throw persistError;
      return { ...stored, ...update.$set };
    },
  };
}

test('auto-check welcome presents Artist as the channel host and explains daily cleanup', () => {
  const embed = buildAutoCheckWelcomeEmbed('vi', { cleanupEnabled: true }).toJSON();

  assert.match(embed.title, /Artist/i);
  // The host speaks in first person and never narrates itself in the third person.
  assert.match(embed.description, /tớ/i);
  assert.doesNotMatch(embed.description, /LoaLogs/i);
  assert.match(embed.fields.map((field) => field.value).join('\n'), /00:00/);
  assert.match(embed.fields.map((field) => field.value).join('\n'), /\/la-help/);
  assert.match(embed.fields.map((field) => field.value).join('\n'), /check <name>/i);
});

test('server-local welcome says cleanup is off and does not promise deletion', () => {
  const embed = buildAutoCheckWelcomeEmbed('vi').toJSON();
  const text = embed.fields.map((field) => field.value).join('\n');

  assert.match(text, /không xoá|không xóa/i);
  // Guard against regressing to the pre-consolidation dead command syntax.
  assert.match(text, /config action:cleanup-on/i);
  assert.doesNotMatch(text, /17:00 UTC/i);
});

test('auto-check welcome stays within Discord embed limits in every language', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    for (const cleanupEnabled of [false, true]) {
      const label = lang + (cleanupEnabled ? ' cleanup-on' : ' cleanup-off');
      const embed = buildAutoCheckWelcomeEmbed(lang, { cleanupEnabled }).toJSON();
      assert.ok(embed.title.length <= 256, label + ' title exceeds 256');
      assert.ok(embed.description.length <= 4096, label + ' description exceeds 4096');
      for (const field of embed.fields) {
        assert.ok(field.name.length <= 256, label + ' field name exceeds 256');
        assert.ok(field.value.length <= 1024, label + ' field value exceeds 1024');
      }
      const totalText = [
        embed.title,
        embed.description,
        embed.footer?.text || '',
        ...embed.fields.flatMap((field) => [field.name, field.value]),
      ].join('');
      assert.ok(totalText.length <= 6000, label + ' embed exceeds 6000');
      assert.doesNotMatch(totalText, /LoaLogs/i, label + ' welcome still names the bot in third person');
    }
  }
});

test('welcome replacement persists the fresh pin before deleting tracked and orphan pins', async () => {
  const trackedOld = createMessage('tracked-old', 'Welcome en');
  const orphanOld = createMessage('orphan-old', 'Welcome vi');
  const unrelated = createMessage('unrelated', 'Other bot pin');
  const fresh = createMessage('fresh', 'Welcome vi');
  const events = [];

  for (const message of [trackedOld, orphanOld]) {
    const originalDelete = message.delete.bind(message);
    message.delete = async () => {
      events.push('delete:' + message.id);
      await originalDelete();
    };
  }

  const oldChannel = {
    id: 'old-channel',
    messages: {
      fetch: async (id) => (id === trackedOld.id ? trackedOld : null),
    },
  };
  const targetChannel = {
    id: 'new-channel',
    messages: {
      fetchPins: async () => ({
        items: [
          { message: orphanOld },
          { message: unrelated },
        ],
      }),
      fetch: async (id) => (id === orphanOld.id ? orphanOld : null),
    },
    async send() {
      events.push('send:fresh');
      return fresh;
    },
  };
  const client = {
    channels: {
      fetch: async (id) => (id === oldChannel.id ? oldChannel : null),
    },
  };
  const GuildConfigModel = createGuildConfig({
    stored: {
      guildId: 'guild-1',
      autoCheckWelcomeMessageId: trackedOld.id,
      autoCheckWelcomeChannelId: oldChannel.id,
    },
  });
  const originalPin = fresh.pin.bind(fresh);
  fresh.pin = async () => {
    events.push('pin:fresh');
    await originalPin();
  };
  const originalPersist = GuildConfigModel.findOneAndUpdate.bind(GuildConfigModel);
  GuildConfigModel.findOneAndUpdate = async (...args) => {
    events.push('persist:fresh');
    return originalPersist(...args);
  };

  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'vi',
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });
  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel: targetChannel,
    client,
    guildId: 'guild-1',
  });

  assert.deepEqual(events, [
    'send:fresh',
    'pin:fresh',
    'persist:fresh',
    'delete:tracked-old',
    'delete:orphan-old',
  ]);
  assert.equal(outcome.posted, true);
  assert.equal(outcome.pinned, true);
  assert.equal(outcome.persisted, true);
  assert.equal(outcome.removedOldCount, 2);
  assert.equal(unrelated.state.deleted, 0);
  assert.deepEqual(GuildConfigModel.updates[0].update, {
    $set: {
      autoCheckWelcomeMessageId: 'fresh',
      autoCheckWelcomeChannelId: 'new-channel',
    },
  });
});

test('first server-local welcome does not run destructive cleanup when cleanup is off', async () => {
  const fresh = createMessage('fresh', 'Welcome vi');
  let cleanupCalls = 0;
  const channel = {
    id: 'channel-1',
    messages: { fetchPins: async () => ({ items: [] }) },
    send: async () => fresh,
  };
  const GuildConfigModel = createGuildConfig();
  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'vi',
    cleanupMessages: async () => {
      cleanupCalls += 1;
      return { deleted: 99, failed: 0, truncated: false };
    },
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    cleanupEnabled: false,
    guildId: 'guild-1',
  });

  assert.equal(cleanupCalls, 0);
  assert.equal(outcome.cleanupAttempted, false);
  assert.equal(outcome.pinned, true);
  assert.equal(
    GuildConfigModel.updates[0].update.$set.lastAutoCheckCleanupKey,
    undefined
  );
});

test('first welcome cleans non-pinned messages before posting and records the cleanup day', async () => {
  const fresh = createMessage('fresh', 'Welcome vi');
  const events = [];
  const channel = {
    id: 'channel-1',
    messages: {
      fetchPins: async () => ({ items: [] }),
    },
    async send() {
      events.push('send:fresh');
      return fresh;
    },
  };
  const originalPin = fresh.pin.bind(fresh);
  fresh.pin = async () => {
    events.push('pin:fresh');
    await originalPin();
  };
  const GuildConfigModel = createGuildConfig();
  const originalPersist = GuildConfigModel.findOneAndUpdate.bind(GuildConfigModel);
  GuildConfigModel.findOneAndUpdate = async (...args) => {
    events.push('persist:fresh');
    return originalPersist(...args);
  };
  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'vi',
    cleanupMessages: async () => {
      events.push('cleanup:first');
      return { deleted: 12, failed: 0, truncated: false };
    },
    getCleanupDayKey: () => '2026-07-10',
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    cleanupEnabled: true,
    configSet: {
      autoCheckChannelId: channel.id,
      autoCheckCleanupEnabled: true,
      updatedByUserId: 'officer-1',
    },
    guildId: 'guild-1',
  });

  assert.deepEqual(events, [
    'cleanup:first',
    'send:fresh',
    'pin:fresh',
    'persist:fresh',
  ]);
  assert.equal(outcome.hadOwnedWelcomePin, false);
  assert.equal(outcome.cleanupAttempted, true);
  assert.equal(outcome.cleanupComplete, true);
  assert.equal(outcome.cleanupDeleted, 12);
  assert.deepEqual(GuildConfigModel.updates[0].update.$set, {
    autoCheckChannelId: 'channel-1',
    autoCheckCleanupEnabled: true,
    updatedByUserId: 'officer-1',
    autoCheckWelcomeMessageId: 'fresh',
    autoCheckWelcomeChannelId: 'channel-1',
    lastAutoCheckCleanupKey: '2026-07-10',
  });
});

test('welcome setup and daily cleanup cannot race across the send-to-pin window', async () => {
  const dayKey = '2026-07-10';
  const state = {
    guildId: 'guild-1',
    autoCheckChannelId: 'channel-1',
    autoCheckCleanupEnabled: true,
  };
  const GuildConfigModel = {
    find() {
      return {
        lean: async () => state.lastAutoCheckCleanupKey === dayKey
          ? []
          : [{ ...state }],
      };
    },
    findOne() {
      return { lean: async () => ({ ...state }) };
    },
    async findOneAndUpdate(query, update) {
      if (
        query.lastAutoCheckCleanupKey?.$ne === dayKey &&
        state.lastAutoCheckCleanupKey === dayKey
      ) {
        return null;
      }
      Object.assign(state, update.$set || {});
      if (update.$unset) {
        for (const key of Object.keys(update.$unset)) delete state[key];
      }
      return { ...state };
    },
  };
  const guard = createAutoCheckChannelGuard();
  const fresh = createMessage('fresh', 'Welcome vi');
  const channel = {
    id: 'channel-1',
    guildId: 'guild-1',
    messages: { fetchPins: async () => ({ items: [] }) },
    send: async () => fresh,
  };
  let initialCleanupStarted;
  const initialCleanupReady = new Promise((resolve) => {
    initialCleanupStarted = resolve;
  });
  let releaseInitialCleanup;
  const initialCleanupGate = new Promise((resolve) => {
    releaseInitialCleanup = resolve;
  });
  let scheduledCleanupCalls = 0;
  const welcomeService = createAutoCheckWelcomeService({
    GuildConfigModel,
    channelGuard: guard,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'vi',
    getCleanupDayKey: () => dayKey,
    cleanupMessages: async () => {
      initialCleanupStarted();
      await initialCleanupGate;
      return { deleted: 0, failed: 0, truncated: false };
    },
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });
  const cleanupService = createAutoCheckCleanupService({
    GuildConfigModel,
    channelGuard: guard,
    nowDate: () => new Date('2026-07-09T17:05:00Z'),
    resolveChannel: async () => channel,
    checkPermissions: () => ({ ok: true, missing: [] }),
    cleanupMessages: async () => {
      scheduledCleanupCalls += 1;
      return { deleted: 0, failed: 0, truncated: false };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const welcomePromise = welcomeService.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    cleanupEnabled: true,
    guildId: 'guild-1',
  });
  await initialCleanupReady;
  const cleanupPromise = cleanupService.runDailyCleanupTick({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fresh.state.pinned, 0);
  assert.equal(scheduledCleanupCalls, 0);

  releaseInitialCleanup();
  const [welcomeOutcome] = await Promise.all([welcomePromise, cleanupPromise]);

  assert.equal(welcomeOutcome.pinned, true);
  assert.equal(welcomeOutcome.persisted, true);
  assert.equal(state.autoCheckWelcomeMessageId, 'fresh');
  assert.equal(state.lastAutoCheckCleanupKey, dayKey);
  assert.equal(scheduledCleanupCalls, 0);
  assert.equal(fresh.state.deleted, 0);
});

test('autochannel config is not persisted when the fresh welcome cannot be pinned', async () => {
  const fresh = createMessage('fresh', 'Welcome en');
  fresh.pin = async () => {
    throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
  };
  const channel = {
    id: 'channel-1',
    messages: { fetchPins: async () => ({ items: [] }) },
    send: async () => fresh,
  };
  const GuildConfigModel = createGuildConfig();
  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'en',
    cleanupMessages: async () => ({ deleted: 0, failed: 0, truncated: false }),
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    configSet: { autoCheckChannelId: channel.id },
    guildId: 'guild-1',
  });

  assert.equal(outcome.pinned, false);
  assert.equal(outcome.persisted, false);
  assert.equal(GuildConfigModel.updates.length, 0);
  assert.equal(fresh.state.deleted, 1);
});

test('first welcome skips destructive cleanup when pin discovery fails', async () => {
  const fresh = createMessage('fresh', 'Welcome en');
  let cleanupCalls = 0;
  const channel = {
    id: 'channel-1',
    messages: {
      fetchPins: async () => {
        throw new Error('pins unavailable');
      },
    },
    send: async () => fresh,
  };
  const GuildConfigModel = createGuildConfig();
  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'en',
    cleanupMessages: async () => {
      cleanupCalls += 1;
      return { deleted: 1, failed: 0, truncated: false };
    },
    getCleanupDayKey: () => '2026-07-10',
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    cleanupEnabled: true,
    guildId: 'guild-1',
  });

  assert.equal(cleanupCalls, 0);
  assert.equal(outcome.pinScanSucceeded, false);
  assert.equal(outcome.cleanupAttempted, false);
  assert.equal(GuildConfigModel.updates[0].update.$set.lastAutoCheckCleanupKey, undefined);
});

test('incomplete first cleanup leaves the day unclaimed so the scheduler can retry', async () => {
  const fresh = createMessage('fresh', 'Welcome en');
  const channel = {
    id: 'channel-1',
    messages: { fetchPins: async () => ({ items: [] }) },
    send: async () => fresh,
  };
  const GuildConfigModel = createGuildConfig();
  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'en',
    cleanupMessages: async () => ({ deleted: 3, failed: 1, truncated: false }),
    getCleanupDayKey: () => '2026-07-10',
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    cleanupEnabled: true,
    guildId: 'guild-1',
  });

  assert.equal(outcome.cleanupAttempted, true);
  assert.equal(outcome.cleanupComplete, false);
  assert.equal(outcome.pinned, true);
  assert.equal(GuildConfigModel.updates[0].update.$set.lastAutoCheckCleanupKey, undefined);
});

test('welcome replacement rolls back the fresh message and preserves old pins on DB failure', async () => {
  const old = createMessage('old', 'Welcome en');
  const fresh = createMessage('fresh', 'Welcome vi');
  const channel = {
    id: 'channel-1',
    messages: {
      fetchPins: async () => ({ items: [{ message: old }] }),
      fetch: async () => old,
    },
    send: async () => fresh,
  };
  const GuildConfigModel = createGuildConfig({
    stored: {
      autoCheckWelcomeMessageId: old.id,
      autoCheckWelcomeChannelId: channel.id,
    },
    persistError: new Error('mongo unavailable'),
  });
  const service = createAutoCheckWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Welcome ' + lang),
    getGuildLanguageFn: async () => 'vi',
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    guildId: 'guild-1',
  });

  assert.equal(outcome.posted, true);
  assert.equal(outcome.pinned, false);
  assert.equal(outcome.persisted, false);
  assert.equal(outcome.removedOldCount, 0);
  assert.equal(fresh.state.pinned, 1);
  assert.equal(fresh.state.unpinned, 1);
  assert.equal(fresh.state.deleted, 1);
  assert.equal(old.state.deleted, 0);
});
