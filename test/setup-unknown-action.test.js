import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { handleSetupCommand } = await import('../bot/handlers/setup/guildSetup.js');

test('/la-setup answers an action that is not in its list', async (t) => {
  clearUserLanguageCache();
  t.after(clearUserLanguageCache);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));

  const edits = [];
  await handleSetupCommand({
    guild: { id: 'guild-1' },
    user: { id: 'admin-1' },
    memberPermissions: { has: () => true },
    options: { getString: (name) => (name === 'action' ? 'cleanup-maybe' : null) },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });

  assert.equal(edits.length, 1);
  assert.match(edits[0].embeds[0].toJSON().description, /cleanup-maybe/);
});

for (const action of ['constructor', '__proto__', 'toString']) {
  test(`/la-setup treats the object member name "${action}" as an unknown action`, async (t) => {
    clearUserLanguageCache();
    t.after(clearUserLanguageCache);
    t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));

    const edits = [];
    await handleSetupCommand({
      guild: { id: 'guild-1' },
      user: { id: 'admin-1' },
      memberPermissions: { has: () => true },
      options: { getString: (name) => (name === 'action' ? action : null) },
      deferReply: async () => {},
      editReply: async (payload) => { edits.push(payload); },
    });

    assert.equal(edits.length, 1);
    assert.match(edits[0].embeds[0].toJSON().title, /Unknown setup action/);
  });
}

test('/la-setup set-language refuses a language it does not support and saves nothing', async (t) => {
  clearUserLanguageCache();
  t.after(clearUserLanguageCache);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const { default: mongoose } = await import('mongoose');
  const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
  t.mock.method(mongoose, 'connect', async () => mongoose);
  const writes = [];
  t.mock.method(GuildConfig, 'updateOne', async (...args) => { writes.push(args); });
  t.mock.method(GuildConfig, 'findOneAndUpdate', (...args) => {
    writes.push(args);
    return { lean: async () => ({ guildId: 'guild-1' }) };
  });

  const edits = [];
  await handleSetupCommand({
    guild: { id: 'guild-1' },
    user: { id: 'admin-1', tag: 'Admin' },
    memberPermissions: { has: () => true },
    options: {
      getString: (name) => ({ action: 'set-language', language: 'klingon' })[name] ?? null,
    },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });

  assert.deepEqual(writes, []);
  assert.equal(edits.length, 1);
  const card = edits[0].embeds[0].toJSON();
  assert.match(card.title, /Unknown language/);
  assert.match(card.description, /klingon/);
});
