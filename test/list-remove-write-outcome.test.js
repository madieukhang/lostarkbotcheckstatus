import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

const { default: mongoose } = await import('mongoose');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { createRemoveHandlers } = await import('../bot/handlers/list/remove/index.js');

const OWNER = 'owner-a';
const serverEntry = {
  _id: 'b'.repeat(24), name: 'Mainchar', reason: 'Server report',
  scope: 'server', guildId: 'guild-1', addedByUserId: OWNER, addedByTag: 'OwnerA',
};
const globalEntry = {
  _id: 'c'.repeat(24), name: 'Mainchar', reason: 'Global report',
  scope: 'global', addedByUserId: OWNER, addedByTag: 'OwnerA',
};

// editReply and the picker button's update reject their first call when asked
// to, standing in for a Discord edit failure after the delete committed.
function setup(t, { blackEntries, deletedCounts = [1], pickCustomId = null, failFirstCard = false }) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(Blacklist, 'find', () => ({ collation: () => ({ lean: async () => blackEntries }) }));
  const nullQuery = () => ({ collation() { return this; }, lean: async () => null });
  t.mock.method(Whitelist, 'findOne', nullQuery);
  t.mock.method(Watchlist, 'findOne', nullQuery);
  t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
  const results = [...deletedCounts];
  t.mock.method(Blacklist, 'deleteOne', async () => ({ acknowledged: true, deletedCount: results.shift() ?? 1 }));

  const replies = [];
  const updates = [];
  const broadcasts = [];
  const button = {
    customId: pickCustomId,
    user: { id: OWNER },
    update: async (payload) => {
      updates.push(payload);
      if (failFirstCard) throw new Error('Discord update failed');
    },
  };
  const { handleListRemoveCommand } = createRemoveHandlers({ services: {
    broadcastListChange: async (...args) => { broadcasts.push(args); },
  } });
  const interaction = {
    user: { id: OWNER, username: 'Owner', tag: 'Owner', globalName: 'Owner' },
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    options: { getString: () => 'Mainchar' },
    deferReply: async () => {},
    editReply: async (payload) => {
      replies.push(payload);
      if (failFirstCard && !pickCustomId && replies.length === 1) throw new Error('Discord edit failed');
      return {};
    },
    fetchReply: async () => ({ awaitMessageComponent: async () => button }),
  };
  return { handleListRemoveCommand, interaction, replies, updates, broadcasts };
}

const titleOf = (payload) => payload.embeds[0].toJSON().title;

test('a failed result card after a single delete is not reported as a failed remove', async (t) => {
  const { handleListRemoveCommand, interaction, replies, broadcasts } = setup(t, {
    blackEntries: [globalEntry], failFirstCard: true,
  });
  await handleListRemoveCommand(interaction);
  assert.equal(replies.length, 1, 'no remove-failed alert follows the rejected card');
  assert.equal(broadcasts.length, 1);
});

test('a failed result card after a picked delete is not reported as a failed remove', async (t) => {
  const { handleListRemoveCommand, interaction, replies, updates, broadcasts } = setup(t, {
    blackEntries: [serverEntry, globalEntry], pickCustomId: 'remove_1', failFirstCard: true,
  });
  await handleListRemoveCommand(interaction);
  assert.equal(updates.length, 1);
  assert.equal(replies.length, 1, 'only the picker was sent, no remove-failed alert');
  assert.equal(broadcasts.length, 1);
});

test('a delete that removed nothing is not broadcast and reads as nothing to remove', async (t) => {
  const { handleListRemoveCommand, interaction, replies, broadcasts } = setup(t, {
    blackEntries: [globalEntry], deletedCounts: [0],
  });
  await handleListRemoveCommand(interaction);
  assert.equal(broadcasts.length, 0);
  assert.equal(replies.length, 1);
  assert.match(titleOf(replies[0]), /Nothing to remove/);
});

test('a picked delete that removed nothing is not broadcast and reads as nothing to remove', async (t) => {
  const { handleListRemoveCommand, interaction, updates, broadcasts } = setup(t, {
    blackEntries: [serverEntry, globalEntry], deletedCounts: [0], pickCustomId: 'remove_0',
  });
  await handleListRemoveCommand(interaction);
  assert.equal(broadcasts.length, 0);
  assert.equal(updates.length, 1);
  assert.match(titleOf(updates[0]), /Nothing to remove/);
  assert.deepEqual(updates[0].components, []);
});

test('remove all reports and broadcasts only the entries it deleted', async (t) => {
  const { handleListRemoveCommand, interaction, updates, broadcasts } = setup(t, {
    blackEntries: [serverEntry, globalEntry], deletedCounts: [0, 1], pickCustomId: 'remove_all',
  });
  await handleListRemoveCommand(interaction);
  assert.equal(broadcasts.length, 1);
  assert.equal(updates.length, 1);
  assert.match(titleOf(updates[0]), /^.{1,3}Removed from Blacklist/u);
});
