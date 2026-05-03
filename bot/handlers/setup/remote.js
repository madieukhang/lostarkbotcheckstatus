import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder } from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import { invalidateGuildConfig } from '../../utils/scope.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { handleSyncImagesAction } from './syncImages.js';
/**
 * Handle /la-remote — Senior-only remote config management
 */
export async function handleSetupRemoteCommand(interaction) {
  const seniorIds = config.seniorApproverIds || [];
  if (!seniorIds.includes(interaction.user.id)) {
    await interaction.reply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.ERROR,
        title: 'Senior-Only Command',
        description: 'Only seniors can use remote config management.',
      })],
      ephemeral: true,
    });
    return;
  }

  const action = interaction.options.getString('action', true);
  const targetGuildId = interaction.options.getString('guild') || '';
  const scopeValue = interaction.options.getString('scope') || '';
  const channelOpt = interaction.options.getChannel('channel');

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
        new EmbedBuilder().setTitle('🛰️ Remote Control — Dashboard').setDescription('*Bot is not in any server.*').setColor(COLORS.greyDark),
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

      const embed = new EmbedBuilder()
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
        .setColor(isOwner ? COLORS.gold : gc ? COLORS.info : COLORS.greyDark);

      // Bot-wide settings only shown on owner guild card
      if (isOwner) {
        const evidenceCh = gc?.evidenceChannelId
          ? `<#${gc.evidenceChannelId}>`
          : '*Not set — images use legacy URL (expire ~24h)*';
        embed.addFields({
          name: '🖼️ Evidence Channel (bot-wide)',
          value: evidenceCh,
          inline: false,
        });
      }

      return embed;
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
      if (i.user.id !== interaction.user.id) {
        await i.reply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Not Your Session',
            description: 'Only the senior who ran this command can use these controls.',
          })],
          ephemeral: true,
        });
        return;
      }
      if (i.customId === 'remote_prev') currentPage = Math.max(0, currentPage - 1);
      else if (i.customId === 'remote_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
      await i.update({ embeds: buildPage(currentPage), components: buildNav(currentPage) });
    });
    collector.on('end', () => {
      interaction.editReply({ components: [] }).catch(() => {});
    });
    return;
  }

  // ── ACTION: evidencechannel ──────────────────────────────
  // Bot-wide setting (not per-guild) — stored on owner GuildConfig.
  // Sets where the bot rehosts /la-list add evidence images for permanent storage.
  if (action === 'evidencechannel') {
    if (!config.ownerGuildId) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Config Missing',
          description: '`OWNER_GUILD_ID` is not configured.',
          footer: 'Set it in env vars and restart the bot, then retry.',
        })],
      });
      return;
    }

    if (!channelOpt) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Channel Option Required',
          description: 'Provide `channel:` option for this action.',
          footer: 'Pick the hidden channel where evidence images will be stored.',
        })],
      });
      return;
    }

    if (!channelOpt.isTextBased?.()) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Wrong Channel Type',
          description: `Channel <#${channelOpt.id}> is not a text channel.`,
        })],
      });
      return;
    }

    // Verify bot can post + read in this channel (best-effort permission check)
    const me = channelOpt.guild?.members?.me;
    if (me) {
      const perms = channelOpt.permissionsFor(me);
      const need = ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory'];
      const missing = need.filter((p) => !perms?.has(p));
      if (missing.length > 0) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Missing Permissions',
            description: `Bot is missing permissions in <#${channelOpt.id}>.`,
            fields: [{ name: 'Missing', value: missing.join(', '), inline: false }],
            footer: 'Grant these permissions and retry the command.',
          })],
        });
        return;
      }
    }

    // Persist to OWNER guild's GuildConfig
    await GuildConfig.findOneAndUpdate(
      { guildId: config.ownerGuildId },
      {
        $set: {
          evidenceChannelId: channelOpt.id,
          updatedByUserId: interaction.user.id,
          updatedByTag: interaction.user.tag,
        },
      },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(config.ownerGuildId);

    const embed = new EmbedBuilder()
      .setTitle('🖼️ Evidence Channel Updated')
      .setDescription(
        `New /la-list add image attachments will be rehosted to <#${channelOpt.id}> ` +
        `for permanent storage. Existing entries are unaffected.`
      )
      .addFields(
        { name: 'Channel', value: `<#${channelOpt.id}>`, inline: true },
        { name: 'Channel ID', value: `\`${channelOpt.id}\``, inline: true },
        { name: 'Server', value: channelOpt.guild?.name || '*Unknown*', inline: true },
      )
      .setColor(COLORS.info)
      .setFooter({ text: `Set by ${interaction.user.tag} · bot-wide setting` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    console.log(`[la-remote] evidenceChannelId → ${channelOpt.id} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: syncimages ───────────────────────────────────
  if (action === 'syncimages') {
    await handleSyncImagesAction(interaction);
    return;
  }

  // ── Need guild ID for off/defaultscope ───────────────────
  if (!targetGuildId) {
    const helpEmbed = new EmbedBuilder()
      .setTitle('❌ Missing Guild ID')
      .setDescription('Use `action:view` first to see all guild IDs, then copy the ID here.')
      .addFields(
        { name: 'Toggle notify', value: '`/la-remote action:off guild:<ID>`', inline: false },
        { name: 'Set scope', value: '`/la-remote action:defaultscope guild:<ID> scope:server`', inline: false },
        { name: 'Set evidence channel', value: '`/la-remote action:evidencechannel channel:#...`', inline: false },
        { name: 'Sync legacy images', value: '`/la-remote action:syncimages` (no guild ID needed)', inline: false },
      )
      .setColor(COLORS.danger);
    await interaction.editReply({ embeds: [helpEmbed] });
    return;
  }

  // Validate target guild — bot must be in it
  const guildName = await resolveGuildName(targetGuildId);
  if (!guildName) {
    const embed = new EmbedBuilder()
      .setTitle('❌ Guild Not Found')
      .setDescription(`Bot is not in a server with ID \`${targetGuildId}\`.\nUse \`action:view\` to see valid guild IDs.`)
      .setColor(COLORS.danger);
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
    console.log(`[la-remote] ${targetGuildId} globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: defaultscope ─────────────────────────────────
  if (action === 'defaultscope') {
    if (!scopeValue) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Scope Required',
          description: 'Provide `scope` value (global/server) for this action.',
        })],
      });
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
    console.log(`[la-remote] ${targetGuildId} defaultBlacklistScope → ${scopeValue} by ${interaction.user.tag}`);
  }
}

