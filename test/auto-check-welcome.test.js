import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoCheckWelcomeEmbed,
  createAutoCheckWelcomeService,
} from '../bot/services/setup/autoCheckWelcome.js';

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

test('auto-check welcome carries Artist as a passerby and explains daily cleanup', () => {
  const embed = buildAutoCheckWelcomeEmbed('vi').toJSON();

  assert.match(embed.title, /Artist/i);
  assert.match(embed.description, /đi ngang/i);
  assert.match(embed.fields.map((field) => field.value).join('\n'), /00:00/);
  assert.match(embed.fields.map((field) => field.value).join('\n'), /\/la-help/);
  assert.match(embed.fields.map((field) => field.value).join('\n'), /check abcxyz/i);
});

test('auto-check welcome stays within Discord embed limits in every language', () => {
  for (const lang of ['en', 'vi', 'jp']) {
    const embed = buildAutoCheckWelcomeEmbed(lang).toJSON();
    assert.ok(embed.title.length <= 256, lang + ' title exceeds 256');
    assert.ok(embed.description.length <= 4096, lang + ' description exceeds 4096');
    for (const field of embed.fields) {
      assert.ok(field.name.length <= 256, lang + ' field name exceeds 256');
      assert.ok(field.value.length <= 1024, lang + ' field value exceeds 1024');
    }
    const totalText = [
      embed.title,
      embed.description,
      embed.footer?.text || '',
      ...embed.fields.flatMap((field) => [field.name, field.value]),
    ].join('');
    assert.ok(totalText.length <= 6000, lang + ' embed exceeds 6000');
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
