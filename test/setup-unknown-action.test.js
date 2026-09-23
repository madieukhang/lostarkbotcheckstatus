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
