import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';

import { AlertSeverity } from '../bot/utils/alertEmbed.js';
import { t } from '../bot/services/i18n/index.js';
import {
  postListNotifySetupWelcome,
  postSetupWelcome,
  reportMissingChannelPermissions,
  requireSetupGuildTextChannel,
  resolveListNotifyWelcomePinContext,
  resolveWelcomePinContext,
} from '../bot/handlers/setup/setupGuards.js';

test('setup text-channel guard returns valid channels and preserves the wrong-channel alert', async () => {
  const alerts = [];
  const validChannel = { id: 'text-1', type: ChannelType.GuildText };
  const validInteraction = {
    options: { getChannel: () => validChannel },
  };
  const invalidInteraction = {
    options: { getChannel: () => ({ id: 'voice-1', type: ChannelType.GuildVoice }) },
  };
  const deps = {
    editAlertFn: async (...args) => alerts.push(args),
  };

  assert.strictEqual(
    await requireSetupGuildTextChannel(validInteraction, 'vi', deps),
    validChannel,
  );
  assert.equal(alerts.length, 0);
  assert.equal(await requireSetupGuildTextChannel(invalidInteraction, 'vi', deps), null);
  assert.deepEqual(alerts[0], [
    invalidInteraction,
    {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.wrongTextChannel', 'vi'),
      lang: 'vi',
    },
  ]);
});

test('setup permission guard keeps the shared localized missing-permission payload', async () => {
  const alerts = [];
  const interaction = { id: 'interaction-1' };

  await reportMissingChannelPermissions(
    interaction,
    'jp',
    'channel-1',
    ['Send Messages', 'Embed Links'],
    { editAlertFn: async (...args) => alerts.push(args) },
  );

  assert.deepEqual(alerts[0], [
    interaction,
    {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.missingPermissions', 'jp', { channel: 'channel-1' }),
      fields: [{
        name: t('dialogue.common.missingField', 'jp'),
        value: '• Send Messages\n• Embed Links',
        inline: false,
      }],
      lang: 'jp',
    },
  ]);
});

test('welcome-pin context resolves the configured channel and one canonical permission policy', async () => {
  const interaction = { guild: { id: 'guild-1' } };
  const guildConfig = { autoCheckChannelId: 'channel-1', autoCheckCleanupEnabled: true };
  const channel = { id: 'channel-1' };
  const calls = [];

  const context = await resolveWelcomePinContext(interaction, guildConfig, {
    resolveChannelFn: async (...args) => {
      calls.push(['resolve', ...args]);
      return channel;
    },
    resolveCleanupFn: () => true,
    checkPermissionsFn: (...args) => {
      calls.push(['permissions', ...args]);
      return { ok: true, missing: [] };
    },
  });

  assert.deepEqual(context, {
    cleanupEnabled: true,
    channel,
    permissions: { ok: true, missing: [] },
  });
  assert.deepEqual(calls, [
    ['resolve', interaction, 'channel-1'],
    ['permissions', channel, interaction.guild, { cleanup: true, welcomePin: true }],
  ]);
});

test('postSetupWelcome forwards the shared Discord and guild context with optional config changes', async () => {
  const client = { user: { id: 'bot-1' } };
  const interaction = {
    client,
    guild: { id: 'guild-1' },
  };
  const channel = { id: 'channel-1' };
  const configSet = { autoCheckChannelId: channel.id };
  let forwarded;

  const outcome = await postSetupWelcome(
    interaction,
    { channel, cleanupEnabled: false, configSet },
    {
      postWelcomeFn: async (payload) => {
        forwarded = payload;
        return { pinned: true, persisted: true };
      },
    },
  );

  assert.deepEqual(forwarded, {
    botUserId: 'bot-1',
    channel,
    client,
    cleanupEnabled: false,
    configSet,
    guildId: 'guild-1',
  });
  assert.deepEqual(outcome, { pinned: true, persisted: true });
});

test('notification welcome context uses its independent cleanup flag and channel', async () => {
  const interaction = { guild: { id: 'guild-1' } };
  const guildConfig = {
    listNotifyChannelId: 'notify-1',
    listNotifyCleanupEnabled: true,
  };
  const channel = { id: 'notify-1' };
  const calls = [];

  const context = await resolveListNotifyWelcomePinContext(interaction, guildConfig, {
    resolveChannelFn: async (...args) => {
      calls.push(['resolve', ...args]);
      return channel;
    },
    checkPermissionsFn: (...args) => {
      calls.push(['permissions', ...args]);
      return { ok: true, missing: [] };
    },
  });

  assert.deepEqual(context, {
    cleanupEnabled: true,
    channel,
    permissions: { ok: true, missing: [] },
  });
  assert.deepEqual(calls, [
    ['resolve', interaction, 'notify-1'],
    ['permissions', channel, interaction.guild, { cleanup: true, welcomePin: true }],
  ]);
});

test('notification setup welcome forwards config atomically with Discord context', async () => {
  const client = { user: { id: 'bot-1' } };
  const interaction = { client, guild: { id: 'guild-1' } };
  const channel = { id: 'notify-1' };
  const configSet = { listNotifyChannelId: channel.id, globalNotifyEnabled: true };
  let forwarded;

  const outcome = await postListNotifySetupWelcome(
    interaction,
    { channel, cleanupEnabled: true, configSet },
    {
      postWelcomeFn: async (payload) => {
        forwarded = payload;
        return { pinned: true, persisted: true };
      },
    },
  );

  assert.deepEqual(forwarded, {
    botUserId: 'bot-1',
    channel,
    client,
    cleanupEnabled: true,
    configSet,
    guildId: 'guild-1',
  });
  assert.deepEqual(outcome, { pinned: true, persisted: true });
});
