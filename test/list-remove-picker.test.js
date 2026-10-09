import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = 'senior-1';
process.env.OFFICER_APPROVER_IDS = 'officer-1';

const { default: mongoose } = await import('mongoose');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { createRemoveHandlers } = await import('../bot/handlers/list/remove/index.js');

function createRemoveInteraction({
  userId = 'user-1',
  name = 'Mainchar',
  pickCustomId = null,
  awaitMessageComponent = null,
} = {}) {
  const replies = [];
  const updates = [];
  const reply = {
    awaitMessageComponent: awaitMessageComponent ?? (async () => ({
      customId: pickCustomId,
      user: { id: userId },
      update: async (payload) => { updates.push(payload); },
    })),
  };
  return {
    replies,
    updates,
    interaction: {
      user: { id: userId, username: 'User', tag: 'User', globalName: 'User' },
      guild: { id: 'guild-1' },
      channelId: 'channel-1',
      options: { getString: (key) => (key === 'name' ? name : null) },
      deferReply: async () => {},
      editReply: async (payload) => {
        replies.push(payload);
        return {};
      },
      fetchReply: async () => reply,
    },
  };
}

function mockListModels(t, { blackEntries = [], whiteEntry = null, watchEntry = null } = {}) {
  // The handler connects for real; without a listener on 127.0.0.1 every
  // test would burn the 30s server-selection timeout before failing.
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(Blacklist, 'find', () => ({
    collation: () => ({ lean: async () => blackEntries }),
  }));
  const nullQuery = () => ({ collation() { return this; }, lean: async () => null });
  t.mock.method(Whitelist, 'findOne', whiteEntry ? () => ({
    collation() { return this; }, lean: async () => whiteEntry,
  }) : nullQuery);
  t.mock.method(Watchlist, 'findOne', watchEntry ? () => ({
    collation() { return this; }, lean: async () => watchEntry,
  }) : nullQuery);
  t.mock.method(RosterSnapshot, 'find', () => ({
    collation() { return this; },
    lean: async () => [],
  }));
}

function trackRemovals(t) {
  const deletes = [];
  const broadcasts = [];
  t.mock.method(Blacklist, 'deleteOne', async (filter) => {
    deletes.push(filter);
    return { deletedCount: 1 };
  });
  const handlers = createRemoveHandlers({
    services: {
      broadcastListChange: (...args) => {
        broadcasts.push(args);
        return Promise.resolve();
      },
    },
  });
  return { deletes, broadcasts, handlers };
}

test('remove picker offers both server and global entries under one name', async (t) => {
  const serverEntry = {
    _id: 'b'.repeat(24), name: 'Mainchar', reason: 'Server report',
    scope: 'server', guildId: 'guild-1', addedByUserId: 'owner-a', addedByTag: 'OwnerA',
  };
  const globalEntry = {
    _id: 'c'.repeat(24), name: 'Mainchar', reason: 'Global report',
    scope: 'global', addedByUserId: 'owner-b', addedByTag: 'OwnerB',
  };
  mockListModels(t, { blackEntries: [serverEntry, globalEntry] });
  const { deletes, handlers } = trackRemovals(t);

  // owner-b owns only the global entry · the server entry shadows it, so the
  // picker must still make the global entry reachable (button index 1).
  const { replies, updates, interaction } = createRemoveInteraction({
    userId: 'owner-b',
    pickCustomId: 'remove_1',
  });
  await handlers.handleListRemoveCommand(interaction);

  const picker = replies[0];
  const description = picker.embeds[0].toJSON().description;
  assert.match(description, /Server report/);
  assert.match(description, /Global report/);
  const buttons = picker.components.flatMap((row) => row.components);
  assert.deepEqual(
    buttons.map((button) => button.data.custom_id),
    ['remove_0', 'remove_1', 'remove_all'],
  );
  assert.deepEqual(deletes, [{ _id: globalEntry._id }]);
  assert.equal(updates.length, 1);
});

test('legacy entries without an owner stay blocked for regular users', async (t) => {
  const legacyEntry = {
    _id: 'd'.repeat(24), name: 'Mainchar', reason: 'Ancient report', scope: 'global',
  };
  mockListModels(t, { blackEntries: [legacyEntry] });
  const { deletes, handlers } = trackRemovals(t);

  const { replies, interaction } = createRemoveInteraction({ userId: 'stranger-1' });
  await handlers.handleListRemoveCommand(interaction);

  assert.deepEqual(deletes, []);
  assert.equal(replies.length, 1);
  const card = replies[0].embeds[0].toJSON();
  assert.match(card.title, /Mainchar/);
});

test('legacy entries without an owner are removable by officers', async (t) => {
  const legacyEntry = {
    _id: 'd'.repeat(24), name: 'Mainchar', reason: 'Ancient report', scope: 'global',
  };
  mockListModels(t, { blackEntries: [legacyEntry] });
  const { deletes, handlers } = trackRemovals(t);

  const { replies, interaction } = createRemoveInteraction({ userId: 'officer-1' });
  await handlers.handleListRemoveCommand(interaction);

  assert.deepEqual(deletes, [{ _id: legacyEntry._id }]);
  assert.equal(replies.length, 1);
});

test('a single owned entry still removes directly without a picker', async (t) => {
  const serverEntry = {
    _id: 'e'.repeat(24), name: 'Mainchar', reason: 'Solo report',
    scope: 'server', guildId: 'guild-1', addedByUserId: 'owner-a', addedByTag: 'OwnerA',
  };
  mockListModels(t, { blackEntries: [serverEntry] });
  const { deletes, handlers } = trackRemovals(t);

  const { replies, interaction } = createRemoveInteraction({ userId: 'owner-a' });
  await handlers.handleListRemoveCommand(interaction);

  assert.deepEqual(deletes, [{ _id: serverEntry._id }]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].components, undefined);
});

test('a picker left unanswered expires quietly and drops its buttons', async (t) => {
  const { DiscordjsError, DiscordjsErrorCodes } = await import('discord.js');
  const serverEntry = {
    _id: 'b'.repeat(24), name: 'Mainchar', reason: 'Server report',
    scope: 'server', guildId: 'guild-1', addedByUserId: 'owner-a', addedByTag: 'OwnerA',
  };
  const globalEntry = {
    _id: 'c'.repeat(24), name: 'Mainchar', reason: 'Global report',
    scope: 'global', addedByUserId: 'owner-a', addedByTag: 'OwnerA',
  };
  mockListModels(t, { blackEntries: [serverEntry, globalEntry] });
  const { deletes, handlers } = trackRemovals(t);

  const { replies, interaction } = createRemoveInteraction({
    userId: 'owner-a',
    awaitMessageComponent: async () => {
      throw new DiscordjsError(DiscordjsErrorCodes.InteractionCollectorError, 'time');
    },
  });
  await handlers.handleListRemoveCommand(interaction);

  assert.deepEqual(deletes, []);
  assert.equal(replies.length, 2);
  const notice = replies[1];
  assert.match(notice.embeds[0].toJSON().title, /expired/i);
  assert.equal(notice.embeds[0].toJSON().fields, undefined, 'no raw error field');
  assert.deepEqual(notice.components, []);
});
