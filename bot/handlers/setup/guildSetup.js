/**
 * handlers/setup/guildSetup.js
 * Handles /la-setup command for per-guild channel configuration.
 * Allows server admins to set auto-check and notification channels
 * without needing to modify environment variables.
 */

import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import { invalidateGuildConfig } from '../../utils/scope.js';
import { COLORS } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import {
  deferEphemeralReply,
  editContent,
  editEmbed,
  replyAlert,
} from '../../utils/interactionReplies.js';

/**
 * Check if the bot has required permissions in a channel.
 * @param {import('discord.js').GuildChannel} channel
 * @param {import('discord.js').Guild} guild
 * @returns {{ ok: boolean, missing: string[] }}
 */
function checkBotPermissions(channel, guild) {
  const botMember = guild.members.me;
  if (!botMember) return { ok: false, missing: ['Cannot resolve bot member'] };

  const perms = channel.permissionsFor(botMember);
  const required = [
    { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
    { flag: PermissionFlagsBits.SendMessages, name: 'Send Messages' },
    { flag: PermissionFlagsBits.ReadMessageHistory, name: 'Read Message History' },
  ];

  const missing = required.filter((r) => !perms.has(r.flag)).map((r) => r.name);
  return { ok: missing.length === 0, missing };
}

/**
 * Send a test message to verify the channel is working.
 * @param {import('discord.js').TextChannel} channel
 * @param {string} purpose - "auto-check" or "notification"
 * @returns {Promise<boolean>}
 */
async function sendTestMessage(channel, purpose) {
  try {
    const msg = await channel.send({
      content: `✅ **Bot connected!** This channel is now set as the **${purpose}** channel via \`/la-setup\`.`,
    });
    // Auto-delete test message after 30 seconds to keep channel clean
    setTimeout(() => msg.delete().catch(() => {}), 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle /la-setup autochannel #channel
 */
async function handleSetupAutoChannel(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      title: 'Wrong Channel Type',
      description: 'Please select a **text channel**.',
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      title: 'Missing Permissions',
      description: `Bot is missing permissions in <#${channel.id}>.`,
      fields: [{
        name: 'Missing',
        value: missing.map((m) => `• ${m}`).join('\n'),
        inline: false,
      }],
      footer: 'Fix the channel permissions and re-run the command.',
    });
    return;
  }

  await deferEphemeralReply(interaction);
  await connectDB();

  // Warn if same channel as notify (allow but warn)
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const sameAsNotify = existing?.listNotifyChannelId === channel.id;

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        autoCheckChannelId: channel.id,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Send test message to verify channel works
  const testOk = await sendTestMessage(channel, 'auto-check');

  const warning = sameAsNotify ? '\n⚠️ This is the same channel as notifications · consider using separate channels to avoid clutter.' : '';

  await editContent(interaction, testOk
    ? `✅ Auto-check channel set to <#${channel.id}>.\nBot will automatically check screenshots posted in this channel.${warning}\n\n*A test message was sent to verify · it will auto-delete in 30s.*`
    : `✅ Auto-check channel set to <#${channel.id}>.${warning}\n⚠️ Could not send a test message · please verify bot permissions.`);

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) set autoCheckChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /la-setup notifychannel #channel
 */
async function handleSetupNotifyChannel(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      title: 'Wrong Channel Type',
      description: 'Please select a **text channel**.',
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      title: 'Missing Permissions',
      description: `Bot is missing permissions in <#${channel.id}>.`,
      fields: [{
        name: 'Missing',
        value: missing.map((m) => `• ${m}`).join('\n'),
        inline: false,
      }],
      footer: 'Fix the channel permissions and re-run the command.',
    });
    return;
  }

  await deferEphemeralReply(interaction);
  await connectDB();

  // Warn if same channel as auto-check (allow but warn)
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const sameAsAutoCheck = existing?.autoCheckChannelId === channel.id;

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        listNotifyChannelId: channel.id,
        globalNotifyEnabled: true, // auto re-enable when setting a notify channel
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  // Send test message to verify channel works
  const testOk = await sendTestMessage(channel, 'notification');
  const warning = sameAsAutoCheck ? '\n⚠️ This is the same channel as auto-check · consider using separate channels to avoid clutter.' : '';

  await editContent(interaction, testOk
    ? `✅ Notification channel set to <#${channel.id}>.\nList add/remove actions will be broadcast here.${warning}\n\n*A test message was sent to verify · it will auto-delete in 30s.*`
    : `✅ Notification channel set to <#${channel.id}>.${warning}\n⚠️ Could not send a test message · please verify bot permissions.`);

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) set listNotifyChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /la-setup off · toggle global notifications on/off
 */
async function handleSetupOff(interaction) {
  await deferEphemeralReply(interaction);
  await connectDB();

  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id });

  // Current state (default true if no config exists)
  const currentlyEnabled = existing?.globalNotifyEnabled ?? true;
  const newState = !currentlyEnabled;

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        globalNotifyEnabled: newState,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (newState) {
    await editContent(interaction, '🔔 Global list notifications **enabled** for this server.\nYou will receive broadcast notifications when entries are added/removed/edited on other servers.');
  } else {
    await editContent(interaction, '🔕 Global list notifications **disabled** for this server.\nYou will no longer receive broadcast notifications from other servers.\n\nRun `/la-setup off` again or `/la-setup notifychannel #channel` to re-enable.');
  }

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
}

/**
 * Handle /la-setup view
 */
async function handleSetupView(interaction) {
  await deferEphemeralReply(interaction);
  await connectDB();

  const guildConfig = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();

  const autoCheckDb = guildConfig?.autoCheckChannelId;
  const notifyDb = guildConfig?.listNotifyChannelId;
  const autoCheckEnv = config.autoCheckChannelIds;
  const notifyEnv = config.listNotifyChannelIds;
  const notifyEnabled = guildConfig?.globalNotifyEnabled ?? true;
  const defaultScope = guildConfig?.defaultBlacklistScope || 'global';
  const scopeEmoji = defaultScope === 'server' ? '🔒' : '🌐';

  // Each setting renders as its own field so the dashboard reads as a
  // 2x2 grid of "what's configured here?" cards instead of a wall of
  // bullet points. The source qualifier (set via /la-setup vs env var
  // fallback vs not configured) goes on a second line in italics so
  // an admin scanning the grid can tell at a glance how each value
  // was provisioned.
  function channelFieldValue(dbId, envIds) {
    if (dbId) return `<#${dbId}>\n*set via /la-setup*`;
    if (envIds.length > 0) return `${envIds.map((id) => `<#${id}>`).join(', ')}\n*from env var fallback*`;
    return '*Not configured*';
  }

  const fields = [
    {
      name: '📸 Auto-check channel',
      value: channelFieldValue(autoCheckDb, autoCheckEnv),
      inline: true,
    },
    {
      name: '🔔 Notification channel',
      value: channelFieldValue(notifyDb, notifyEnv),
      inline: true,
    },
    {
      name: '​',
      value: '​',
      inline: true,
    },
    {
      name: `${scopeEmoji} Default blacklist scope`,
      value: `**${defaultScope}**\n*\`/la-list add type:black\` defaults to ${defaultScope} when scope is omitted*`,
      inline: true,
    },
    {
      name: '📡 Global notifications',
      value: notifyEnabled
        ? '**🔔 Enabled**\n*Receives broadcasts from other servers*'
        : '**🔕 Disabled**\n*Does not receive broadcasts from other servers*',
      inline: true,
    },
    {
      name: '​',
      value: '​',
      inline: true,
    },
  ];

  const footerParts = [];
  if (guildConfig?.updatedAt) {
    const updatedAtUnix = Math.floor(new Date(guildConfig.updatedAt).getTime() / 1000);
    footerParts.push(`Last updated by ${guildConfig.updatedByTag || 'Unknown'} · <t:${updatedAtUnix}:R>`);
  } else {
    footerParts.push('No persisted config yet · values shown are env / defaults');
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: `${interaction.guild.name} · Bot Configuration` })
    .setDescription('Per-server settings for the Lost Ark Check bot. Use the matching `/la-setup` subcommand to change any of these.')
    .addFields(fields)
    .setColor(COLORS.info)
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  await editEmbed(interaction, embed);
}

export async function handleSetupCommand(interaction) {
  if (!interaction.guild) {
    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      title: 'Server-Only Command',
      description: 'This command can only be used inside a Discord server, not in DMs.',
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  // Remote is senior-only (checked inside handler). All others need ManageGuild.
  if (subcommand !== 'remote') {
    const hasManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!hasManageGuild) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Permission Required',
        description: 'You need the **Manage Server** permission to use this command.',
      });
      return;
    }
  }

  if (subcommand === 'autochannel') {
    await handleSetupAutoChannel(interaction);
  } else if (subcommand === 'notifychannel') {
    await handleSetupNotifyChannel(interaction);
  } else if (subcommand === 'off') {
    await handleSetupOff(interaction);
  } else if (subcommand === 'defaultscope') {
    await handleSetupDefaultScope(interaction);
  } else if (subcommand === 'view') {
    await handleSetupView(interaction);
  }
}

/**
 * Handle /la-setup defaultscope global|server
 */
async function handleSetupDefaultScope(interaction) {
  const scope = interaction.options.getString('scope', true);

  await deferEphemeralReply(interaction);
  await connectDB();

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        defaultBlacklistScope: scope,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  const emoji = scope === 'server' ? '🔒' : '🌐';
  await editContent(interaction, `${emoji} Default blacklist scope set to **${scope}**.\nWhen \`/la-list add type:black\` is used without specifying scope, entries will default to **${scope}**.`);

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) defaultBlacklistScope → ${scope} by ${interaction.user.tag}`);
}
