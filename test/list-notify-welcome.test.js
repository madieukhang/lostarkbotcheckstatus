import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListNotifyWelcomeEmbed,
  createListNotifyWelcomeService,
} from '../bot/services/setup/listNotifyWelcome.js';
import { createChannelLifecycleGuard } from '../bot/services/setup/channelLifecycleGuard.js';

function fakeEmbed(title) {
  return { toJSON: () => ({ title }) };
}

function createMessage(id, title, { pinError = null } = {}) {
  const state = { deleted: 0, pinned: 0, unpinned: 0 };
  return {
    id,
    author: { id: 'bot' },
    embeds: [{ title }],
    state,
    async delete() { state.deleted += 1; },
    async pin() {
      if (pinError) throw pinError;
      state.pinned += 1;
    },
    async unpin() { state.unpinned += 1; },
  };
}

test('notification welcome explains the retained and 30-minute cleanup states', () => {
  const retained = buildListNotifyWelcomeEmbed('vi').toJSON();
  const cleaned = buildListNotifyWelcomeEmbed('vi', { cleanupEnabled: true }).toJSON();
  const retainedText = retained.fields.map((field) => field.value).join('\n');
  const cleanedText = cleaned.fields.map((field) => field.value).join('\n');

  assert.match(retained.title, /thông báo|notification/i);
  assert.match(retainedText, /notify-cleanup-on/i);
  assert.match(retainedText, /giữ lại|ở nguyên/i);
  assert.match(cleanedText, /30 phút/i);
  assert.match(cleanedText, /5 phút/i);
  assert.match(cleanedText, /tin đã ghim|ghim không/i);
});

test('notification welcome stays inside Discord embed limits in every language', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    for (const cleanupEnabled of [false, true]) {
      const embed = buildListNotifyWelcomeEmbed(lang, { cleanupEnabled }).toJSON();
      assert.ok(embed.title.length <= 256);
      assert.ok(embed.description.length <= 4096);
      for (const field of embed.fields) {
        assert.ok(field.name.length <= 256);
        assert.ok(field.value.length <= 1024);
      }
      const total = [
        embed.title,
        embed.description,
        embed.footer?.text || '',
        ...embed.fields.flatMap((field) => [field.name, field.value]),
      ].join('');
      assert.ok(total.length <= 6000);
    }
  }
});

test('notification welcome persists the fresh pin before removing its predecessor', async () => {
  const old = createMessage('old', 'Notify en');
  const fresh = createMessage('fresh', 'Notify vi');
  const events = [];
  old.delete = async () => {
    events.push('delete:old');
    old.state.deleted += 1;
  };
  fresh.pin = async () => {
    events.push('pin:fresh');
    fresh.state.pinned += 1;
  };
  const updates = [];
  const GuildConfigModel = {
    findOne: () => ({
      lean: async () => ({
        guildId: 'guild-1',
        listNotifyWelcomeMessageId: old.id,
        listNotifyWelcomeChannelId: 'notify-1',
      }),
    }),
    async findOneAndUpdate(query, update, options) {
      events.push('persist:fresh');
      updates.push({ query, update, options });
      return update.$set;
    },
  };
  const channel = {
    id: 'notify-1',
    guildId: 'guild-1',
    messages: {
      fetchPins: async () => ({ items: [{ message: old }] }),
      fetch: async () => old,
    },
    async send() {
      events.push('send:fresh');
      return fresh;
    },
  };
  const guard = createChannelLifecycleGuard();
  guard.rememberWelcome('notify-1', old.id);
  guard.rememberWelcome('notify-1', 'auto-check-welcome');
  const service = createListNotifyWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang) => fakeEmbed('Notify ' + lang),
    getGuildLanguageFn: async () => 'vi',
    channelGuard: guard,
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    cleanupEnabled: true,
    configSet: {
      listNotifyChannelId: channel.id,
      listNotifyCleanupEnabled: true,
    },
    guildId: 'guild-1',
  });

  assert.deepEqual(events, [
    'send:fresh',
    'pin:fresh',
    'persist:fresh',
    'delete:old',
  ]);
  assert.equal(outcome.pinned, true);
  assert.equal(outcome.persisted, true);
  assert.equal(outcome.removedOldCount, 1);
  assert.deepEqual(
    new Set(guard.getProtectedMessageIds('notify-1')),
    new Set(['auto-check-welcome', 'fresh'])
  );
  assert.deepEqual(updates[0].update.$set, {
    listNotifyChannelId: 'notify-1',
    listNotifyCleanupEnabled: true,
    listNotifyWelcomeMessageId: 'fresh',
    listNotifyWelcomeChannelId: 'notify-1',
  });
});

test('notification channel config is not persisted when its welcome cannot be pinned', async () => {
  const fresh = createMessage('fresh', 'Notify en', {
    pinError: new Error('Missing Permissions'),
  });
  let updates = 0;
  const service = createListNotifyWelcomeService({
    GuildConfigModel: {
      findOne: () => ({ lean: async () => null }),
      findOneAndUpdate: async () => { updates += 1; },
    },
    buildWelcomeEmbed: (lang) => fakeEmbed('Notify ' + lang),
    getGuildLanguageFn: async () => 'en',
    channelGuard: createChannelLifecycleGuard(),
    supportedLanguageCodes: ['en', 'vi', 'jp'],
    logger: { warn() {} },
  });
  const channel = {
    id: 'notify-1',
    guildId: 'guild-1',
    messages: { fetchPins: async () => ({ items: [] }) },
    send: async () => fresh,
  };

  const outcome = await service.postWelcome({
    botUserId: 'bot',
    channel,
    client: { channels: { fetch: async () => channel } },
    configSet: { listNotifyChannelId: channel.id },
    guildId: 'guild-1',
  });

  assert.equal(outcome.pinned, false);
  assert.equal(outcome.persisted, false);
  assert.equal(updates, 0);
  assert.equal(fresh.state.deleted, 1);
});
