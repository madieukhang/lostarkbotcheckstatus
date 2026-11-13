import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscordjsErrorCodes } from 'discord.js';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { default: config } = await import('../bot/config.js');
const { t } = await import('../bot/services/i18n/index.js');
const {
  getProtectedGuildIds,
  handleRemoteGuildAutocomplete,
  handleLeaveAction,
} = await import('../bot/handlers/setup/remoteServers.js');

const OWNER_GUILD = 'g-owner';
const SENIOR = 'senior-1';
const JOINED = Date.UTC(2026, 2, 2);

function useConfig(testContext, overrides = {}) {
  const values = {
    ownerGuildId: OWNER_GUILD,
    channelId: 'c-unknown',
    listNotifyChannelIds: [],
    autoCheckChannelIds: [],
    seniorApproverIds: [SENIOR],
    ...overrides,
  };
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, config[key]]));
  Object.assign(config, values);
  testContext.after(() => Object.assign(config, saved));
}

function makeGuild(id, name, { leave } = {}) {
  const guild = {
    id,
    name,
    memberCount: 14,
    joinedTimestamp: JOINED,
    leaveCalls: 0,
    async leave() {
      guild.leaveCalls += 1;
      if (leave) await leave();
    },
  };
  return guild;
}

// The application owner is the leave interactions' user unless a test says otherwise.
function makeClient(guilds = [], channels = [], { ownerId = 'owner-1' } = {}) {
  return {
    application: { owner: { id: ownerId } },
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
  };
}

function makeAutocomplete(client, { focused = { name: 'guild', value: '' }, action = 'leave', userId = SENIOR } = {}) {
  const interaction = {
    client,
    user: { id: userId },
    responded: null,
    options: {
      getFocused: () => focused,
      getString: (name) => (name === 'action' ? action : null),
    },
    async respond(choices) { interaction.responded = choices; },
  };
  return interaction;
}

function makeButton(customId, userId = 'owner-1') {
  const button = {
    customId,
    user: { id: userId },
    updates: [],
    deferred: 0,
    async update(payload) { button.updates.push(payload); },
    async deferUpdate() { button.deferred += 1; },
  };
  return button;
}

function makeLeaveInteraction(client, click = async () => makeButton('remote_leave_cancel')) {
  const message = {
    awaitOptions: null,
    async awaitMessageComponent(options) {
      message.awaitOptions = options;
      return click(options);
    },
  };
  const interaction = {
    client,
    user: { id: 'owner-1', tag: 'Traine' },
    edits: [],
    async editReply(payload) {
      interaction.edits.push(payload);
      return message;
    },
  };
  return { interaction, message };
}

const embedOf = (payload) => {
  const embed = payload.embeds[0];
  return embed.toJSON ? embed.toJSON() : embed;
};
const titleKey = (key) => t(key, 'en').title;
const lastEdit = (interaction) => interaction.edits.at(-1);

test('protected ids hold the owner guild and env channel guilds', (testContext) => {
  useConfig(testContext, { channelId: 'c-monitor', listNotifyChannelIds: ['c-gone'], autoCheckChannelIds: ['c-auto'] });
  const client = makeClient([], [
    { id: 'c-monitor', guildId: 'g-monitor' },
    { id: 'c-auto', guildId: 'g-auto' },
  ]);
  assert.deepEqual([...getProtectedGuildIds(client)].sort(), ['g-auto', 'g-monitor', OWNER_GUILD].sort());
});

test('suggestions answer [] for a non-Senior', async (testContext) => {
  useConfig(testContext);
  const interaction = makeAutocomplete(makeClient([makeGuild('g-a', 'Alpha')]), { userId: 'member-1' });
  await handleRemoteGuildAutocomplete(interaction);
  assert.deepEqual(interaction.responded, []);
});

test('suggestions answer [] for a focused option other than guild', async (testContext) => {
  useConfig(testContext);
  const interaction = makeAutocomplete(makeClient([makeGuild('g-a', 'Alpha')]), { focused: { name: 'scope', value: '' } });
  await handleRemoteGuildAutocomplete(interaction);
  assert.deepEqual(interaction.responded, []);
});

test('suggestions hide protected guilds only for leave', async (testContext) => {
  useConfig(testContext);
  const client = makeClient([makeGuild(OWNER_GUILD, 'Home'), makeGuild('g-a', 'Alpha')]);
  const leave = makeAutocomplete(client, { action: 'leave' });
  await handleRemoteGuildAutocomplete(leave);
  assert.deepEqual(leave.responded.map(({ value }) => value), ['g-a']);
  const off = makeAutocomplete(client, { action: 'off' });
  await handleRemoteGuildAutocomplete(off);
  assert.deepEqual(off.responded, [
    { name: '🏠 Alpha', value: 'g-a' },
    { name: '👑 Home', value: OWNER_GUILD },
  ]);
});

test('suggestions match name or id without case', async (testContext) => {
  useConfig(testContext);
  const client = makeClient([makeGuild('111abc222', 'Other'), makeGuild('g-2', 'Guild ABC'), makeGuild('g-3', 'Zeta')]);
  const interaction = makeAutocomplete(client, { focused: { name: 'guild', value: 'ABC' } });
  await handleRemoteGuildAutocomplete(interaction);
  assert.deepEqual(interaction.responded.map(({ value }) => value).sort(), ['111abc222', 'g-2']);
  assert.equal(interaction.responded.find(({ value }) => value === 'g-2').name, '🏠 Guild ABC');
});

test('suggestions cap at 25 and cut labels', async (testContext) => {
  useConfig(testContext);
  const many = Array.from({ length: 30 }, (_, i) => makeGuild(`g-${i}`, `Server ${String(29 - i).padStart(2, '0')}`));
  const capped = makeAutocomplete(makeClient(many));
  await handleRemoteGuildAutocomplete(capped);
  assert.equal(capped.responded.length, 25);
  assert.equal(capped.responded[0].name, '🏠 Server 00');

  const long = makeAutocomplete(makeClient([makeGuild('g-long', 'x'.repeat(120))]));
  await handleRemoteGuildAutocomplete(long);
  assert.equal(long.responded[0].name.length, 100);
  assert.equal(long.responded[0].value, 'g-long');
});

test('leave refuses a non-owner', async (testContext) => {
  useConfig(testContext);
  const guild = makeGuild('g-a', 'Alpha');
  const { interaction, message } = makeLeaveInteraction(makeClient([guild], [], { ownerId: 'someone-else' }));
  await handleLeaveAction(interaction, 'g-a', 'en');
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleKey('dialogue.remote.leave.ownerOnly')));
  assert.equal(message.awaitOptions, null);
  assert.equal(guild.leaveCalls, 0);
});

test('leave refuses a protected guild typed by id', async (testContext) => {
  useConfig(testContext);
  const guild = makeGuild(OWNER_GUILD, 'Home');
  const { interaction } = makeLeaveInteraction(makeClient([guild]));
  await handleLeaveAction(interaction, OWNER_GUILD, 'en');
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleKey('dialogue.remote.leave.protected')));
  assert.equal(guild.leaveCalls, 0);
});

test('leave refuses an id the bot is not in', async (testContext) => {
  useConfig(testContext);
  const { interaction } = makeLeaveInteraction(makeClient([]));
  await handleLeaveAction(interaction, 'g-missing', 'en');
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleKey('dialogue.remote.guildNotFound')));
});

test('leave shows the confirmation card', async (testContext) => {
  useConfig(testContext);
  const { interaction } = makeLeaveInteraction(makeClient([makeGuild('g-a', 'Alpha')]));
  await handleLeaveAction(interaction, 'g-a', 'en');
  const card = interaction.edits[0];
  const values = embedOf(card).fields.map(({ value }) => value).join('\n');
  assert.ok(values.includes('Alpha'));
  assert.ok(values.includes('g-a'));
  assert.ok(values.includes('14'));
  assert.ok(values.includes(`<t:${Math.floor(JOINED / 1000)}:D>`));
  const ids = card.components[0].toJSON().components.map(({ custom_id: id }) => id);
  assert.deepEqual(ids, ['remote_leave_confirm', 'remote_leave_cancel']);
});

test('confirmation filter accepts only the invoker', async (testContext) => {
  useConfig(testContext);
  const { interaction, message } = makeLeaveInteraction(makeClient([makeGuild('g-a', 'Alpha')]));
  await handleLeaveAction(interaction, 'g-a', 'en');
  assert.equal(message.awaitOptions.filter({ user: { id: 'owner-1' } }), true);
  assert.equal(message.awaitOptions.filter({ user: { id: 'someone-else' } }), false);
  assert.equal(message.awaitOptions.time, 60_000);
});

test('confirm leaves once and logs', async (testContext) => {
  useConfig(testContext);
  const log = testContext.mock.method(console, 'log', () => {});
  const guild = makeGuild('g-a', 'Alpha');
  const button = makeButton('remote_leave_confirm');
  const { interaction } = makeLeaveInteraction(makeClient([guild]), async () => button);
  await handleLeaveAction(interaction, 'g-a', 'en');
  assert.equal(guild.leaveCalls, 1);
  assert.equal(button.deferred, 1);
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleKey('dialogue.remote.leave.done')));
  assert.deepEqual(lastEdit(interaction).components, []);
  assert.ok(log.mock.calls.some(({ arguments: [line] }) => line === '[la-remote] left Alpha (g-a) by Traine'));
});

test('cancel and timeout never leave', async (testContext) => {
  useConfig(testContext);
  const guild = makeGuild('g-a', 'Alpha');
  const cancel = makeButton('remote_leave_cancel');
  const cancelled = makeLeaveInteraction(makeClient([guild]), async () => cancel);
  await handleLeaveAction(cancelled.interaction, 'g-a', 'en');
  assert.ok(embedOf(cancel.updates[0]).title.includes(titleKey('dialogue.remote.leave.cancelled')));
  assert.deepEqual(cancel.updates[0].components, []);

  const timedOut = makeLeaveInteraction(makeClient([guild]), async () => {
    throw Object.assign(new Error('time'), { code: DiscordjsErrorCodes.InteractionCollectorError });
  });
  await handleLeaveAction(timedOut.interaction, 'g-a', 'en');
  assert.ok(embedOf(lastEdit(timedOut.interaction)).title.includes(titleKey('dialogue.remote.leave.expired')));
  assert.deepEqual(lastEdit(timedOut.interaction).components, []);
  assert.equal(guild.leaveCalls, 0);
});

test('confirm after the guild vanished does not leave', async (testContext) => {
  useConfig(testContext);
  const guild = makeGuild('g-a', 'Alpha');
  const client = makeClient([guild]);
  const { interaction } = makeLeaveInteraction(client, async () => {
    client.guilds.cache.delete('g-a');
    return makeButton('remote_leave_confirm');
  });
  await handleLeaveAction(interaction, 'g-a', 'en');
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleKey('dialogue.remote.guildNotFound')));
  assert.equal(guild.leaveCalls, 0);
});

test('a throwing leave shows the failed card', async (testContext) => {
  useConfig(testContext);
  testContext.mock.method(console, 'error', () => {});
  const guild = makeGuild('g-a', 'Alpha', { leave: async () => { throw new Error('Missing Access'); } });
  const { interaction } = makeLeaveInteraction(makeClient([guild]), async () => makeButton('remote_leave_confirm'));
  await handleLeaveAction(interaction, 'g-a', 'en');
  assert.ok(embedOf(lastEdit(interaction)).title.includes(titleKey('dialogue.remote.leave.failed')));
});

// An unavailable guild (a Discord outage at ready) carries only its id.
function makeUnavailableGuild(id) {
  const guild = { id, available: false, leaveCalls: 0, async leave() { guild.leaveCalls += 1; } };
  return guild;
}

test('suggestions keep working when a guild is unavailable', async (testContext) => {
  useConfig(testContext);
  const interaction = makeAutocomplete(makeClient([makeGuild('g-a', 'Alpha'), makeUnavailableGuild('g-x')]));
  await handleRemoteGuildAutocomplete(interaction);
  assert.deepEqual(interaction.responded, [
    { name: '🏠 Alpha', value: 'g-a' },
    { name: '🏠 g-x', value: 'g-x' },
  ]);
});

test('the confirmation card of an unavailable guild shows its id and no NaN date', async (testContext) => {
  useConfig(testContext);
  const { interaction } = makeLeaveInteraction(makeClient([makeUnavailableGuild('g-x')]));
  await handleLeaveAction(interaction, 'g-x', 'en');
  const values = embedOf(interaction.edits[0]).fields.map(({ value }) => value).join('\n');
  assert.ok(values.includes('g-x'));
  assert.ok(!values.includes('NaN'));
  assert.ok(!values.includes('undefined'));
});

test('suggestion labels never end in half an emoji', async (testContext) => {
  useConfig(testContext);
  // '🏠 ' takes 3 UTF-16 units, so the emoji straddles the 100-unit cut.
  const interaction = makeAutocomplete(makeClient([makeGuild('g-1', `${'x'.repeat(96)}😀`)]));
  await handleRemoteGuildAutocomplete(interaction);
  assert.equal(interaction.responded[0].name, `🏠 ${'x'.repeat(96)}`);
});

test('a stranger-set server name is escaped on the cards', async (testContext) => {
  useConfig(testContext);
  testContext.mock.method(console, 'log', () => {});
  const name = '[x](https://evil.test) **b**';
  const { interaction } = makeLeaveInteraction(
    makeClient([makeGuild('g-a', name)]),
    async () => makeButton('remote_leave_confirm'),
  );
  await handleLeaveAction(interaction, 'g-a', 'en');
  for (const payload of [interaction.edits[0], lastEdit(interaction)]) {
    const card = embedOf(payload);
    const shown = [card.description, ...(card.fields || []).map(({ value }) => value)].join('\n');
    assert.ok(!shown.includes('[x](https://evil.test)'), shown);
    assert.ok(shown.includes(String.raw`\[x\](https://evil.test) \*\*b\*\*`), shown);
  }
});

test('the la-remote autocomplete route serves the server suggestions', async (testContext) => {
  useConfig(testContext);
  const { createAutocompleteRoutes } = await import('../bot/app/interaction-router.js');
  const interaction = makeAutocomplete(makeClient([makeGuild('g-a', 'Alpha')]));
  await createAutocompleteRoutes()['la-remote'](interaction);
  assert.deepEqual(interaction.responded, [{ name: '🏠 Alpha', value: 'g-a' }]);
});

test('/la-remote action:leave reaches the confirmation card', async (testContext) => {
  useConfig(testContext, { seniorApproverIds: ['owner-1'] });
  const { default: mongoose } = await import('mongoose');
  const { default: UserPreference } = await import('../bot/models/UserPreference.js');
  const { disconnectDB } = await import('../bot/db.js');
  const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
  const { handleSetupRemoteCommand } = await import('../bot/handlers/setup/remote.js');
  testContext.mock.method(mongoose, 'connect', async () => mongoose);
  testContext.after(disconnectDB);
  clearUserLanguageCache();
  testContext.after(() => clearUserLanguageCache());
  testContext.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));

  const client = makeClient([makeGuild('g-a', 'Alpha')]);
  client.guilds.fetch = async (id) => {
    if (!client.guilds.cache.has(id)) throw new Error('Unknown Guild');
    return client.guilds.cache.get(id);
  };
  const { interaction } = makeLeaveInteraction(client);
  const options = { action: 'leave', guild: 'g-a' };
  Object.assign(interaction, {
    options: { getString: (name) => options[name] ?? null, getChannel: () => null },
    deferReply: async () => {},
  });
  await handleSetupRemoteCommand(interaction);
  const ids = interaction.edits[0].components[0].toJSON().components.map(({ custom_id: id }) => id);
  assert.deepEqual(ids, ['remote_leave_confirm', 'remote_leave_cancel']);
});
