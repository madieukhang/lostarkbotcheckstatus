/**
 * setupHandler.js
 * Handles /lasetup command for per-guild channel configuration.
 * Allows server admins to set auto-check and notification channels
 * without needing to modify environment variables.
 */

import { ChannelType, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';

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
      content: `✅ **Bot connected!** This channel is now set as the **${purpose}** channel via \`/lasetup\`.`,
    });
    // Auto-delete test message after 30 seconds to keep channel clean
    setTimeout(() => msg.delete().catch(() => {}), 30_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle /lasetup autochannel #channel
 */
async function handleSetupAutoChannel(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: '❌ Please select a **text channel**.',
      ephemeral: true,
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await interaction.reply({
      content: `❌ Bot is missing permissions in <#${channel.id}>:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nPlease fix channel permissions and try again.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        autoCheckChannelId: channel.id,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, new: true }
  );

  // Send test message to verify channel works
  const testOk = await sendTestMessage(channel, 'auto-check');

  await interaction.editReply({
    content: testOk
      ? `✅ Auto-check channel set to <#${channel.id}>.\nBot will automatically check screenshots posted in this channel.\n\n*A test message was sent to verify — it will auto-delete in 30s.*`
      : `✅ Auto-check channel set to <#${channel.id}>.\n⚠️ Could not send a test message — please verify bot permissions.`,
  });

  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) set autoCheckChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup notifychannel #channel
 */
async function handleSetupNotifyChannel(interaction) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: '❌ Please select a **text channel**.',
      ephemeral: true,
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await interaction.reply({
      content: `❌ Bot is missing permissions in <#${channel.id}>:\n${missing.map((m) => `• ${m}`).join('\n')}\n\nPlease fix channel permissions and try again.`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        listNotifyChannelId: channel.id,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, new: true }
  );

  // Send test message to verify channel works
  const testOk = await sendTestMessage(channel, 'notification');

  await interaction.editReply({
    content: testOk
      ? `✅ Notification channel set to <#${channel.id}>.\nList add/remove actions will be broadcast here.\n\n*A test message was sent to verify — it will auto-delete in 30s.*`
      : `✅ Notification channel set to <#${channel.id}>.\n⚠️ Could not send a test message — please verify bot permissions.`,
  });

  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) set listNotifyChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup reset
 */
async function handleSetupReset(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  const deleted = await GuildConfig.findOneAndDelete({ guildId: interaction.guild.id });

  if (!deleted) {
    await interaction.editReply({
      content: '⚠️ No configuration found for this server. Nothing to reset.',
    });
    return;
  }

  const parts = [];
  if (deleted.autoCheckChannelId) parts.push(`📸 Auto-check: <#${deleted.autoCheckChannelId}>`);
  if (deleted.listNotifyChannelId) parts.push(`🔔 Notification: <#${deleted.listNotifyChannelId}>`);

  const fallbackNote = config.autoCheckChannelIds.length > 0 || config.listNotifyChannelIds.length > 0
    ? '\n\nBot will fall back to global env var channels (if configured).'
    : '';

  await interaction.editReply({
    content: `🗑️ Configuration reset. Removed:\n${parts.join('\n')}${fallbackNote}`,
  });

  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) config reset by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup view
 */
async function handleSetupView(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  const guildConfig = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();

  const autoCheckDb = guildConfig?.autoCheckChannelId;
  const notifyDb = guildConfig?.listNotifyChannelId;

  // Env var fallback info
  const autoCheckEnv = config.autoCheckChannelIds;
  const notifyEnv = config.listNotifyChannelIds;

  const lines = [];

  // Auto-check channel
  lines.push('**📸 Auto-check channel:**');
  if (autoCheckDb) {
    lines.push(`  → <#${autoCheckDb}> *(set via /lasetup)*`);
  } else if (autoCheckEnv.length > 0) {
    lines.push(`  → ${autoCheckEnv.map((id) => `<#${id}>`).join(', ')} *(from env vars)*`);
  } else {
    lines.push('  → *Not configured*');
  }

  lines.push('');

  // Notify channel
  lines.push('**🔔 Notification channel:**');
  if (notifyDb) {
    lines.push(`  → <#${notifyDb}> *(set via /lasetup)*`);
  } else if (notifyEnv.length > 0) {
    lines.push(`  → ${notifyEnv.map((id) => `<#${id}>`).join(', ')} *(from env vars)*`);
  } else {
    lines.push('  → *Not configured*');
  }

  if (guildConfig?.updatedAt) {
    lines.push('');
    lines.push(`Last updated: <t:${Math.floor(new Date(guildConfig.updatedAt).getTime() / 1000)}:R> by ${guildConfig.updatedByTag || 'Unknown'}`);
  }

  const embed = new EmbedBuilder()
    .setTitle('⚙️ Bot Configuration')
    .setDescription(lines.join('\n'))
    .setColor(0x5865f2)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

export async function handleSetupCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: '❌ This command can only be used in a server.',
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'autochannel') {
    await handleSetupAutoChannel(interaction);
  } else if (subcommand === 'notifychannel') {
    await handleSetupNotifyChannel(interaction);
  } else if (subcommand === 'reset') {
    await handleSetupReset(interaction);
  } else if (subcommand === 'view') {
    await handleSetupView(interaction);
  }
}
