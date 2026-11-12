import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';
process.env.OWNER_GUILD_ID = 'owner-guild';
process.env.LIST_NOTIFY_CHANNEL_IDS = 'env-a,env-b,env-c,env-d,env-owner';

const { createBroadcastServices } = await import('../bot/handlers/list/services/broadcasts.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');

// Notify channels configured in the database: guild-c has broadcasts off.
const GUILD_CONFIGS = [
  { guildId: 'guild-a', listNotifyChannelId: 'db-a' },
  { guildId: 'guild-b', listNotifyChannelId: 'db-b' },
  { guildId: 'guild-c', listNotifyChannelId: 'db-c', globalNotifyEnabled: false },
];
// The server each channel belongs to, for the environment channels.
const CHANNEL_GUILDS = {
  'db-a': 'guild-a', 'db-b': 'guild-b', 'db-c': 'guild-c', 'db-owner': 'owner-guild',
  'env-a': 'guild-a', 'env-b': 'guild-b', 'env-c': 'guild-c', 'env-d': 'guild-d', 'env-owner': 'owner-guild',
};

// Broadcasts one global add from the origin server and returns the channels it reached.
async function broadcastFrom(t, originGuildId, guildConfigs = GUILD_CONFIGS) {
  t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
  t.mock.method(GuildConfig, 'find', () => ({ lean: async () => guildConfigs }));
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const reached = [];
  const { broadcastBulkAdd } = createBroadcastServices({
    client: {
      channels: {
        fetch: async (id) => ({
          isTextBased: () => true,
          guild: { id: CHANNEL_GUILDS[id] },
          send: async () => { reached.push(id); },
        }),
      },
    },
  });
  await broadcastBulkAdd(
    [{ type: 'black', entry: { name: 'Someone', type: 'black', reason: 'reason', scope: 'global' } }],
    { guildId: originGuildId },
  );
  return reached.sort();
}

test('a broadcast skips the channels of the server it came from', async (t) => {
  // env-b and env-c stay out too: their servers set a notify channel or turned broadcasts off.
  assert.deepEqual(await broadcastFrom(t, 'guild-a'), ['db-b', 'env-d', 'env-owner']);
});

test('a broadcast skips the environment channel of a server with no configured channel', async (t) => {
  assert.deepEqual(await broadcastFrom(t, 'guild-d'), ['db-a', 'db-b', 'env-owner']);
});

test('a broadcast from the owner server also reaches the owner server', async (t) => {
  assert.deepEqual(await broadcastFrom(t, 'owner-guild'), ['db-a', 'db-b', 'env-d', 'env-owner']);
});

test('the owner server keeps its own configured channel too', async (t) => {
  const withOwner = [...GUILD_CONFIGS, { guildId: 'owner-guild', listNotifyChannelId: 'db-owner' }];
  // env-owner stays out: the owner server set a notify channel.
  assert.deepEqual(await broadcastFrom(t, 'owner-guild', withOwner), ['db-a', 'db-b', 'db-owner', 'env-d']);
});
