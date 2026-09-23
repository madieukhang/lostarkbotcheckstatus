import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

const { default: mongoose } = await import('mongoose');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { disconnectDB } = await import('../bot/db.js');
const { invalidateGuildConfig } = await import('../bot/utils/scope.js');
const { SETUP_ACTION_HANDLERS } = await import('../bot/handlers/setup/guildSetup.js');

function vietnamDayKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(date);
}

test('cleanup-on claims today so the first purge waits for 00:00', async (t) => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => {
    invalidateGuildConfig('guild-1');
    await disconnectDB();
  });
  t.mock.method(GuildConfig, 'findOne', () => ({
    lean: async () => ({ guildId: 'guild-1', autoCheckChannelId: 'chan-1' }),
  }));
  const updates = [];
  t.mock.method(GuildConfig, 'findOneAndUpdate', async (_filter, update) => {
    updates.push(update);
    return null;
  });

  // The pin scan fails, so the welcome refresh gives up without touching
  // the channel; only the cleanup toggle write is under test.
  const offline = async () => { throw new Error('offline'); };
  const channel = {
    id: 'chan-1',
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetchPins: offline, fetchPinned: offline, fetch: offline },
    send: offline,
  };
  const interaction = {
    guild: { id: 'guild-1', name: 'Guild', channels: { cache: new Map([['chan-1', channel]]) }, members: { me: {} } },
    user: { id: 'admin-1', tag: 'Admin#0001' },
    client: { user: { id: 'bot-1' } },
    editReply: async () => {},
  };

  const before = vietnamDayKey(new Date());
  await SETUP_ACTION_HANDLERS['cleanup-on'](interaction, 'en');
  const after = vietnamDayKey(new Date());

  const toggle = updates[0].$set;
  assert.equal(toggle.autoCheckCleanupEnabled, true);
  assert.ok([before, after].includes(toggle.lastAutoCheckCleanupKey), JSON.stringify(toggle));
});
