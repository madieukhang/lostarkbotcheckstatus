import { ChannelType } from 'discord.js';

import { postAutoCheckWelcome } from '../../services/setup/autoCheckWelcome.js';
import { postListNotifyWelcome } from '../../services/setup/listNotifyWelcome.js';
import { checkBotPermissions } from '../../services/setup/channelPermissions.js';
import { resolveAutoCheckCleanupEnabled } from '../../services/setup/autoCheckCleanupPolicy.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { editAlert } from '../../utils/interactionReplies.js';
import { t } from '../../services/i18n/index.js';

export async function requireSetupGuildTextChannel(
  interaction,
  lang,
  { editAlertFn = editAlert } = {},
) {
  const channel = interaction.options.getChannel('channel', true);
  if (channel.type === ChannelType.GuildText) return channel;

  await editAlertFn(interaction, {
    severity: AlertSeverity.ERROR,
    ...t('dialogue.common.wrongTextChannel', lang),
    lang,
  });
  return null;
}

export async function reportMissingChannelPermissions(
  interaction,
  lang,
  channelId,
  missing,
  { editAlertFn = editAlert } = {},
) {
  await editAlertFn(interaction, {
    severity: AlertSeverity.ERROR,
    ...t('dialogue.common.missingPermissions', lang, { channel: channelId }),
    fields: [{
      name: t('dialogue.common.missingField', lang),
      value: missing.map((entry) => `• ${entry}`).join('\n'),
      inline: false,
    }],
    lang,
  });
}

export async function resolveGuildTextChannel(interaction, channelId) {
  if (!channelId) return null;
  let channel = interaction.guild?.channels?.cache?.get(channelId) || null;
  if (!channel && interaction.guild?.channels?.fetch) {
    try {
      channel = await interaction.guild.channels.fetch(channelId);
    } catch {
      channel = null;
    }
  }
  return channel?.type === ChannelType.GuildText ? channel : null;
}

export async function resolveWelcomePinContext(
  interaction,
  guildConfig,
  {
    resolveChannelFn = resolveGuildTextChannel,
    checkPermissionsFn = checkBotPermissions,
    resolveCleanupFn = resolveAutoCheckCleanupEnabled,
  } = {},
) {
  const cleanupEnabled = resolveCleanupFn(guildConfig);
  const channel = await resolveChannelFn(interaction, guildConfig?.autoCheckChannelId);
  const permissions = channel
    ? checkPermissionsFn(channel, interaction.guild, {
        cleanup: cleanupEnabled,
        welcomePin: true,
      })
    : null;

  return { cleanupEnabled, channel, permissions };
}

export async function resolveListNotifyWelcomePinContext(
  interaction,
  guildConfig,
  {
    resolveChannelFn = resolveGuildTextChannel,
    checkPermissionsFn = checkBotPermissions,
  } = {},
) {
  const cleanupEnabled = guildConfig?.listNotifyCleanupEnabled === true;
  const channel = await resolveChannelFn(interaction, guildConfig?.listNotifyChannelId);
  const permissions = channel
    ? checkPermissionsFn(channel, interaction.guild, {
        cleanup: cleanupEnabled,
        welcomePin: true,
      })
    : null;

  return { cleanupEnabled, channel, permissions };
}

export async function postSetupWelcome(
  interaction,
  { channel, cleanupEnabled, configSet },
  { postWelcomeFn = postAutoCheckWelcome } = {},
) {
  return postWelcomeFn({
    botUserId: interaction.client.user.id,
    channel,
    client: interaction.client,
    cleanupEnabled,
    ...(configSet ? { configSet } : {}),
    guildId: interaction.guild.id,
  });
}

export async function postListNotifySetupWelcome(
  interaction,
  { channel, cleanupEnabled, configSet },
  { postWelcomeFn = postListNotifyWelcome } = {},
) {
  return postWelcomeFn({
    botUserId: interaction.client.user.id,
    channel,
    client: interaction.client,
    cleanupEnabled,
    ...(configSet ? { configSet } : {}),
    guildId: interaction.guild.id,
  });
}
