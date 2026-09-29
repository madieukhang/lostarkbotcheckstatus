import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import mongoose from 'mongoose';

import { buildCommands } from '../bot/commands/index.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { startReadyBackgroundServices } from '../bot/app/lifecycle.js';
import { handleSetupCommand, SETUP_ACTION_HANDLERS } from '../bot/handlers/setup/guildSetup.js';

test('/la-setup collapses into a single config subcommand with the action option', () => {
  const setup = buildCommands().find((command) => command.name === 'la-setup');
  assert.ok(setup);

  const subs = setup.options.filter((option) => option.type === 1); // SUB_COMMAND
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, 'config');

  const opts = Object.fromEntries(subs[0].options.map((option) => [option.name, option]));
  assert.ok(opts.action, 'action option present');
  assert.equal(opts.action.autocomplete, true);
  assert.equal(opts.action.required, true);
  assert.ok(opts.channel, 'channel option present');
  assert.ok(opts.language, 'language option present');
  assert.ok(opts.scope, 'scope option present');
  assert.deepEqual(opts.scope.choices.map((choice) => choice.value), ['global', 'server']);
});

test('/la-setup dispatch maps every action to a handler', () => {
  assert.deepEqual(Object.keys(SETUP_ACTION_HANDLERS).sort(), [
    'cleanup-off', 'cleanup-on', 'notify-cleanup', 'notify-cleanup-off',
    'notify-cleanup-on', 'notify-off', 'notify-on', 'notify-repin', 'repin',
    'set-auto-channel', 'set-default-scope', 'set-language', 'set-notify-channel', 'show',
  ]);
});

test('GuildConfig tracks the welcome pin and daily cleanup cursor', () => {
  assert.ok(GuildConfig.schema.path('autoCheckWelcomeMessageId'));
  assert.ok(GuildConfig.schema.path('autoCheckWelcomeChannelId'));
  assert.equal(GuildConfig.schema.path('autoCheckCleanupEnabled').options.default, false);
  assert.ok(GuildConfig.schema.path('lastAutoCheckCleanupKey'));
  assert.ok(GuildConfig.schema.path('listNotifyWelcomeMessageId'));
  assert.ok(GuildConfig.schema.path('listNotifyWelcomeChannelId'));
  assert.equal(GuildConfig.schema.path('listNotifyCleanupEnabled').options.default, false);
  assert.ok(GuildConfig.schema.path('lastListNotifyCleanupKey'));
});

test('ready background services include both channel cleanup schedulers', () => {
  const calls = [];
  const client = { id: 'client' };

  startReadyBackgroundServices(client, {
    startMonitorFn: (value) => calls.push(['monitor', value]),
    setupAutoCheckFn: (value) => calls.push(['auto-check', value]),
    startAutoCheckCleanupFn: (value) => calls.push(['cleanup', value]),
    startListNotifyCleanupFn: (value) => calls.push(['notify-cleanup', value]),
  });

  assert.deepEqual(calls, [
    ['monitor', client],
    ['auto-check', client],
    ['cleanup', client],
    ['notify-cleanup', client],
  ]);
});

function mockGuildConfig(context, stored) {
  const writes = [];
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => stored }));
  context.mock.method(GuildConfig, 'findOneAndUpdate', async (_filter, update) => {
    writes.push(update.$set);
    return null;
  });
  context.after(disconnectDB);
  return writes;
}

// Pins read as empty and the message history fetch fails, so any cleanup
// the welcome flow runs ends incomplete.
function createTextChannel({ missingFlag = null } = {}) {
  const calls = { sent: 0, cleanupFetches: 0 };
  const channel = {
    id: 'chan-1',
    name: 'auto-check',
    guildId: 'guild-1',
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: (flag) => flag !== missingFlag }),
    messages: {
      fetchPins: async () => [],
      fetch: async () => {
        calls.cleanupFetches += 1;
        throw new Error('offline');
      },
    },
    send: async () => {
      calls.sent += 1;
      return { id: 'welcome-1', pin: async () => {} };
    },
  };
  return { channel, calls };
}

function createSetupInteraction(channel) {
  return {
    guild: {
      id: 'guild-1',
      name: 'Guild',
      members: { me: {} },
      channels: { cache: new Map([[channel.id, channel]]) },
    },
    user: { id: 'admin-1', tag: 'Admin#0001' },
    client: { user: { id: 'bot-1' } },
    options: { getChannel: () => channel },
    editReply: async () => {},
  };
}

test('/la-setup set-auto-channel does not claim the cleanup day when its cleanup fails', async (t) => {
  const writes = mockGuildConfig(t, { guildId: 'guild-1', autoCheckCleanupEnabled: true });
  const { channel, calls } = createTextChannel();

  await SETUP_ACTION_HANDLERS['set-auto-channel'](createSetupInteraction(channel), 'en');

  assert.ok(calls.cleanupFetches > 0, 'the initial cleanup ran');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].autoCheckChannelId, 'chan-1');
  assert.equal(writes[0].autoCheckCleanupEnabled, true);
  assert.equal(Object.hasOwn(writes[0], 'lastAutoCheckCleanupKey'), false);
});

test('/la-setup repin requires cleanup permission and cleans while the schedule is off', async (t) => {
  mockGuildConfig(t, {
    guildId: 'guild-1',
    autoCheckChannelId: 'chan-1',
    autoCheckCleanupEnabled: false,
  });

  const blocked = createTextChannel({ missingFlag: PermissionFlagsBits.ManageMessages });
  await SETUP_ACTION_HANDLERS.repin(createSetupInteraction(blocked.channel), 'en');
  assert.equal(blocked.calls.sent, 0);

  const allowed = createTextChannel();
  await SETUP_ACTION_HANDLERS.repin(createSetupInteraction(allowed.channel), 'en');
  assert.ok(allowed.calls.cleanupFetches > 0, 'repin forced a cleanup');
  assert.equal(allowed.calls.sent, 1);
});

test('/la-setup stops members without Manage Server before reading the action', async (t) => {
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => null }));
  let checkedFlag;
  const replies = [];

  await handleSetupCommand({
    guild: { id: 'guild-1' },
    user: { id: 'member-1' },
    memberPermissions: {
      has: (flag) => {
        checkedFlag = flag;
        return false;
      },
    },
    options: { getString: () => assert.fail('the action must not be read') },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  });

  assert.equal(checkedFlag, PermissionFlagsBits.ManageGuild);
  assert.equal(replies.length, 1);
});
