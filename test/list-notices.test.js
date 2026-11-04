import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { DiscordjsErrorCodes } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = '';
process.env.OFFICER_APPROVER_IDS = '';

const { createTrustHandlers } = await import('../bot/handlers/list/trust/index.js');
const { createRemoveHandlers } = await import('../bot/handlers/list/remove/index.js');
const { createListEditCommandHandler } = await import('../bot/handlers/list/edit/command.js');
const { createListAddCommandHandler } = await import('../bot/handlers/list/add/command.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { COLORS } = await import('../bot/utils/ui.js');

// A Mongoose query stand-in that can be awaited directly or through lean().
function query(value) {
  const chain = {
    collation: () => chain,
    lean: async () => value,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

function stubVietnameseDb(context, { black = [], white = null, watch = null } = {}) {
  clearUserLanguageCache();
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(UserPreference, 'findOne', () => query({ language: 'vi' }));
  context.mock.method(GuildConfig, 'findOne', () => query(null));
  context.mock.method(Blacklist, 'find', () => query(black));
  context.mock.method(Whitelist, 'findOne', () => query(white));
  context.mock.method(Watchlist, 'findOne', () => query(watch));
  context.mock.method(RosterSnapshot, 'find', () => query([]));
  context.mock.method(console, 'warn', () => {});
  context.after(() => clearUserLanguageCache());
}

function interactionWith(options, extra = {}) {
  const payloads = [];
  return {
    payloads,
    user: { id: 'member', username: 'Member', tag: 'Member#0001' },
    guild: { id: 'guild' },
    channelId: 'channel',
    options: {
      getString: (key) => options[key] ?? null,
      getAttachment: () => null,
    },
    deferReply: async () => {},
    reply: async (payload) => { payloads.push(payload); },
    editReply: async (payload) => { payloads.push(payload); },
    ...extra,
  };
}

const cardOf = (payload) => payload.embeds[0].toJSON();

test('/la-list trust: officer only is a guard notice', async (context) => {
  stubVietnameseDb(context);
  const interaction = interactionWith({ action: 'add', name: 'Mokoko' });
  await createTrustHandlers().handleListTrustCommand(interaction);

  const card = cardOf(interaction.payloads[0]);
  assert.ok(card.title.startsWith('🔒  '), card.title);
  assert.equal(card.color, COLORS.warning);
});

test('/la-list remove: a picker left to time out is an expired notice', async (context) => {
  stubVietnameseDb(context, {
    black: [
      { _id: 'a', name: 'Mokoko', scope: 'global', addedByUserId: 'member' },
      { _id: 'b', name: 'Mokoko', scope: 'server', guildId: 'guild', addedByUserId: 'member' },
    ],
  });
  const timedOut = Object.assign(new Error('Collector received no interactions'), {
    code: DiscordjsErrorCodes.InteractionCollectorError,
  });
  const interaction = interactionWith({ name: 'Mokoko' }, {
    fetchReply: async () => ({ awaitMessageComponent: async () => { throw timedOut; } }),
  });
  const { handleListRemoveCommand } = createRemoveHandlers({ services: { broadcastListChange: async () => {} } });
  await handleListRemoveCommand(interaction);

  const card = cardOf(interaction.payloads.at(-1));
  assert.ok(card.title.startsWith('⌛  '), card.title);
  assert.equal(card.color, COLORS.muted);
});

test('/la-list edit: an entry that is not on any list is an empty notice', async (context) => {
  stubVietnameseDb(context);
  const interaction = interactionWith({ name: 'Mokoko', reason: 'new reason' });
  const handleListEditCommand = createListEditCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: async () => assert.fail('nothing to send'),
    broadcastListChange: async () => {},
  });
  await handleListEditCommand(interaction);

  const card = cardOf(interaction.payloads.at(-1));
  assert.ok(card.title.startsWith('🔍  '), card.title);
  assert.equal(card.color, COLORS.info);
});

test('/la-list add: a request no approver received is a failure notice with a tip', async (context) => {
  stubVietnameseDb(context);
  const interaction = interactionWith({ type: 'watch', name: 'Mokoko', reason: 'Left mid-raid' });
  const handleListAddCommand = createListAddCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: async () => ({ success: false, reason: 'No approver reachable' }),
    executeListAddToDatabase: async () => assert.fail('a member add waits for approval'),
  });
  await handleListAddCommand(interaction);

  const card = cardOf(interaction.payloads.at(-1));
  assert.ok(card.title.startsWith('❌  '), card.title);
  assert.equal(card.color, COLORS.danger);
  assert.deepEqual(card.fields.map(({ name, value }) => [name, value]), [['🧾 Chi tiết', '`No approver reachable`']]);
  assert.ok(card.footer.text.startsWith('💡 '), card.footer.text);
});
