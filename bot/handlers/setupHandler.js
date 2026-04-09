/**
 * setupHandler.js
 * Handles /lasetup command for per-guild channel configuration.
 * Allows server admins to set auto-check and notification channels
 * without needing to modify environment variables.
 */

import { ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import { invalidateGuildConfig } from '../utils/scope.js';

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

  const warning = sameAsNotify ? '\n⚠️ This is the same channel as notifications — consider using separate channels to avoid clutter.' : '';

  await interaction.editReply({
    content: testOk
      ? `✅ Auto-check channel set to <#${channel.id}>.\nBot will automatically check screenshots posted in this channel.${warning}\n\n*A test message was sent to verify — it will auto-delete in 30s.*`
      : `✅ Auto-check channel set to <#${channel.id}>.${warning}\n⚠️ Could not send a test message — please verify bot permissions.`,
  });

  invalidateGuildConfig(interaction.guild.id);
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
  const warning = sameAsAutoCheck ? '\n⚠️ This is the same channel as auto-check — consider using separate channels to avoid clutter.' : '';

  await interaction.editReply({
    content: testOk
      ? `✅ Notification channel set to <#${channel.id}>.\nList add/remove actions will be broadcast here.${warning}\n\n*A test message was sent to verify — it will auto-delete in 30s.*`
      : `✅ Notification channel set to <#${channel.id}>.${warning}\n⚠️ Could not send a test message — please verify bot permissions.`,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) set listNotifyChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup off — toggle global notifications on/off
 */
async function handleSetupOff(interaction) {
  await interaction.deferReply({ ephemeral: true });
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
    await interaction.editReply({
      content: '🔔 Global list notifications **enabled** for this server.\nYou will receive broadcast notifications when entries are added/removed/edited on other servers.',
    });
  } else {
    await interaction.editReply({
      content: '🔕 Global list notifications **disabled** for this server.\nYou will no longer receive broadcast notifications from other servers.\n\nRun `/lasetup off` again or `/lasetup notifychannel #channel` to re-enable.',
    });
  }

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
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

  // Global notification status
  const notifyEnabled = guildConfig?.globalNotifyEnabled ?? true;
  lines.push('');
  lines.push(`**📡 Global notifications:** ${notifyEnabled ? '🔔 Enabled' : '🔕 Disabled'}`);
  if (!notifyEnabled) {
    lines.push('  → *This server will not receive broadcast notifications from other servers*');
  }

  // Default blacklist scope
  const defaultScope = guildConfig?.defaultBlacklistScope || 'global';
  const scopeEmoji = defaultScope === 'server' ? '🔒' : '🌐';
  lines.push('');
  lines.push(`**${scopeEmoji} Default blacklist scope:** ${defaultScope}`);
  lines.push(`  → *\`/list add type:black\` without scope will default to ${defaultScope}*`);

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

  // Remote is senior-only (checked inside handler). All others need ManageGuild.
  if (subcommand !== 'remote') {
    const hasManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!hasManageGuild) {
      await interaction.reply({ content: '❌ You need **Manage Server** permission to use this command.', ephemeral: true });
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
 * Handle /lasetup defaultscope global|server
 */
async function handleSetupDefaultScope(interaction) {
  const scope = interaction.options.getString('scope', true);

  await interaction.deferReply({ ephemeral: true });
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
  await interaction.editReply({
    content: `${emoji} Default blacklist scope set to **${scope}**.\nWhen \`/list add type:black\` is used without specifying scope, entries will default to **${scope}**.`,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[lasetup] Guild ${interaction.guild.name} (${interaction.guild.id}) defaultBlacklistScope → ${scope} by ${interaction.user.tag}`);
}

/**
 * Handle /lasetup remote — Senior-only remote config management
 */
export async function handleSetupRemoteCommand(interaction) {
  const seniorIds = config.seniorApproverIds || [];
  if (!seniorIds.includes(interaction.user.id)) {
    await interaction.reply({ content: '❌ Only seniors can use remote config management.', ephemeral: true });
    return;
  }

  const action = interaction.options.getString('action', true);
  const targetGuildId = interaction.options.getString('guild') || '';
  const scopeValue = interaction.options.getString('scope') || '';

  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  // Helper: resolve guild name from ID
  async function resolveGuildName(gid) {
    try { return (await interaction.client.guilds.fetch(gid)).name; } catch { return null; }
  }

  // ── ACTION: view ─────────────────────────────────────────
  if (action === 'view') {
    const allGuilds = [...interaction.client.guilds.cache.values()];
    const allConfigs = await GuildConfig.find({}).lean();
    const configMap = new Map(allConfigs.map((gc) => [gc.guildId, gc]));

    if (allGuilds.length === 0) {
      await interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle('🛰️ Remote Control — Dashboard').setDescription('*Bot is not in any server.*').setColor(0x95a5a6),
      ] });
      return;
    }

    function buildServerEmbed(guild) {
      const gc = configMap.get(guild.id);
      const isOwner = guild.id === config.ownerGuildId;
      const notify = gc?.globalNotifyEnabled === false ? '🔕 Disabled' : '🔔 Enabled';
      const scope = gc?.defaultBlacklistScope || 'global';
      const scopeDisplay = scope === 'server' ? '🔒 Server (Local)' : '🌐 Global';
      const autoCheck = gc?.autoCheckChannelId ? `<#${gc.autoCheckChannelId}>` : '*Not set*';
      const notifyCh = gc?.listNotifyChannelId ? `<#${gc.listNotifyChannelId}>` : '*Not set*';
      const updated = gc?.updatedAt ? `<t:${Math.floor(new Date(gc.updatedAt).getTime() / 1000)}:R>` : '—';
      const configured = gc ? '✅' : '⚪';

      return new EmbedBuilder()
        .setTitle(`${isOwner ? '👑' : '🖥️'} ${guild.name} ${configured}`)
        .setDescription(`\`${guild.id}\`${isOwner ? ' — **Owner Server**' : ''}${!gc ? ' — *No config yet*' : ''}`)
        .addFields(
          { name: '📡 Global Notify', value: notify, inline: true },
          { name: '🎯 Default Scope', value: scopeDisplay, inline: true },
          { name: '📸 Auto-check', value: autoCheck, inline: true },
          { name: '🔔 Notify Channel', value: notifyCh, inline: true },
          { name: '🕐 Last Updated', value: updated, inline: true },
          { name: '👤 Updated By', value: gc?.updatedByTag || '—', inline: true },
        )
        .setColor(isOwner ? 0xf1c40f : gc ? 0x5865f2 : 0x95a5a6);
    }

    // Owner embed always pinned on top
    const ownerGuild = allGuilds.find((g) => g.id === config.ownerGuildId);
    const otherGuilds = allGuilds.filter((g) => g.id !== config.ownerGuildId);
    const ownerEmbed = ownerGuild ? buildServerEmbed(ownerGuild) : null;

    // Paginate other servers (max 9 per page since owner takes 1 slot)
    const perPage = 3;
    const totalPages = Math.max(1, Math.ceil(otherGuilds.length / perPage));
    let currentPage = 0;

    function buildPage(page) {
      const start = page * perPage;
      const pageGuilds = otherGuilds.slice(start, start + perPage);
      const embeds = ownerEmbed ? [ownerEmbed] : [];
      for (const guild of pageGuilds) embeds.push(buildServerEmbed(guild));
      return embeds;
    }

    function buildNav(page) {
      if (totalPages <= 1) return [];
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('remote_prev').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('remote_page').setLabel(`${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('remote_next').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      )];
    }

    const msg = await interaction.editReply({ embeds: buildPage(0), components: buildNav(0) });

    if (totalPages <= 1) return;

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000 });
    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) { await i.reply({ content: '❌', ephemeral: true }); return; }
      if (i.customId === 'remote_prev') currentPage = Math.max(0, currentPage - 1);
      else if (i.customId === 'remote_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
      await i.update({ embeds: buildPage(currentPage), components: buildNav(currentPage) });
    });
    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
    return;
  }

  // ── Need guild ID for off/defaultscope ───────────────────
  if (!targetGuildId) {
    const helpEmbed = new EmbedBuilder()
      .setTitle('❌ Missing Guild ID')
      .setDescription('Use `action:view` first to see all guild IDs, then copy the ID here.')
      .addFields(
        { name: 'Toggle notify', value: '`/laremote action:off guild:<ID>`', inline: false },
        { name: 'Set scope', value: '`/laremote action:defaultscope guild:<ID> scope:server`', inline: false },
      )
      .setColor(0xed4245);
    await interaction.editReply({ embeds: [helpEmbed] });
    return;
  }

  // Validate target guild — bot must be in it
  const guildName = await resolveGuildName(targetGuildId);
  if (!guildName) {
    const embed = new EmbedBuilder()
      .setTitle('❌ Guild Not Found')
      .setDescription(`Bot is not in a server with ID \`${targetGuildId}\`.\nUse \`action:view\` to see valid guild IDs.`)
      .setColor(0xed4245);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const auditFields = { updatedByUserId: interaction.user.id, updatedByTag: interaction.user.tag };

  // ── ACTION: off ──────────────────────────────────────────
  if (action === 'off') {
    const existing = await GuildConfig.findOne({ guildId: targetGuildId });
    const currentlyEnabled = existing?.globalNotifyEnabled ?? true;
    const newState = !currentlyEnabled;

    await GuildConfig.findOneAndUpdate(
      { guildId: targetGuildId },
      { $set: { globalNotifyEnabled: newState, ...auditFields } },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(targetGuildId);

    const embed = new EmbedBuilder()
      .setTitle(`${newState ? '🔔' : '🔕'} Remote — Notify ${newState ? 'Enabled' : 'Disabled'}`)
      .addFields(
        { name: 'Server', value: `**${guildName}**\n\`${targetGuildId}\``, inline: true },
        { name: 'Status', value: newState ? '🔔 Receiving broadcasts' : '🔕 Silent — no broadcasts', inline: true },
      )
      .setColor(newState ? 0x2ecc71 : 0xe74c3c)
      .setFooter({ text: `Changed by ${interaction.user.tag} · silent — server not notified` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[lasetup] Remote: ${targetGuildId} globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: defaultscope ─────────────────────────────────
  if (action === 'defaultscope') {
    if (!scopeValue) {
      await interaction.editReply({ content: '❌ Provide `scope` value (global/server) for this action.' });
      return;
    }

    await GuildConfig.findOneAndUpdate(
      { guildId: targetGuildId },
      { $set: { defaultBlacklistScope: scopeValue, ...auditFields } },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(targetGuildId);

    const scopeDisplay = scopeValue === 'server' ? '🔒 Server (Local)' : '🌐 Global';
    const embed = new EmbedBuilder()
      .setTitle(`${scopeValue === 'server' ? '🔒' : '🌐'} Remote — Scope Updated`)
      .addFields(
        { name: 'Server', value: `**${guildName}**\n\`${targetGuildId}\``, inline: true },
        { name: 'Default Scope', value: scopeDisplay, inline: true },
      )
      .setColor(scopeValue === 'server' ? 0x9b59b6 : 0x3498db)
      .setFooter({ text: `Changed by ${interaction.user.tag} · silent — server not notified` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[lasetup] Remote: ${targetGuildId} defaultBlacklistScope → ${scopeValue} by ${interaction.user.tag}`);
  }
}
