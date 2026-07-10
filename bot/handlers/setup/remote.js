import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';

import { createArtistEmbed } from '../../utils/artistVoice.js';
import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import UserPreference from '../../models/UserPreference.js';
import { invalidateGuildConfig } from '../../utils/scope.js';
import { COLORS } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import {
  deferEphemeralReply,
  editAlert,
  editEmbed,
  editPayload,
  replyAlert,
  updatePayload,
} from '../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { handleSyncImagesAction } from './syncImages.js';
/**
 * Handle /la-remote · Senior-only remote config management
 */
export async function handleSetupRemoteCommand(interaction) {
  await deferEphemeralReply(interaction);
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
  const seniorIds = config.seniorApproverIds || [];
  if (!seniorIds.includes(interaction.user.id)) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.remote.seniorOnly', lang),
      lang,
    });
    return;
  }

  const action = interaction.options.getString('action', true);
  const targetGuildId = interaction.options.getString('guild') || '';
  const scopeValue = interaction.options.getString('scope') || '';
  const channelOpt = interaction.options.getChannel('channel');

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
      await editEmbed(
        interaction,
        createArtistEmbed(lang)
          .setTitle(`🛰️ ${t('dialogue.remote.dashboardTitle', lang)}`)
          .setDescription(`*${t('dialogue.remote.noServers', lang)}*`)
          .setColor(COLORS.greyDark),
      );
      return;
    }

    function buildServerEmbed(guild) {
      const gc = configMap.get(guild.id);
      const isOwner = guild.id === config.ownerGuildId;
      const notify = gc?.globalNotifyEnabled === false
        ? `🔕 ${t('dialogue.remote.state.disabled', lang)}`
        : `🔔 ${t('dialogue.remote.state.enabled', lang)}`;
      const scope = gc?.defaultBlacklistScope || 'global';
      const scopeDisplay = scope === 'server'
        ? `🔒 ${t('dialogue.remote.state.local', lang)}`
        : `🌐 ${t('dialogue.remote.state.global', lang)}`;
      const autoCheck = gc?.autoCheckChannelId ? `<#${gc.autoCheckChannelId}>` : `*${t('dialogue.remote.notSet', lang)}*`;
      const notifyCh = gc?.listNotifyChannelId ? `<#${gc.listNotifyChannelId}>` : `*${t('dialogue.remote.notSet', lang)}*`;
      const updated = gc?.updatedAt ? `<t:${Math.floor(new Date(gc.updatedAt).getTime() / 1000)}:R>` : '-';
      const configured = gc ? '✅' : '⚪';

      const embed = createArtistEmbed(lang)
        .setTitle(`${isOwner ? '👑' : '🖥️'} ${guild.name} ${configured}`)
        .setDescription(`\`${guild.id}\`${isOwner ? ` · **${t('dialogue.remote.ownerServer', lang)}**` : ''}${!gc ? ` · *${t('dialogue.remote.noConfig', lang)}*` : ''}`)
        .addFields(
          { name: `📡 ${t('dialogue.remote.fields.globalNotify', lang)}`, value: notify, inline: true },
          { name: `🎯 ${t('dialogue.remote.fields.defaultScope', lang)}`, value: scopeDisplay, inline: true },
          { name: `📸 ${t('dialogue.remote.fields.autoCheck', lang)}`, value: autoCheck, inline: true },
          { name: `🔔 ${t('dialogue.remote.fields.notifyChannel', lang)}`, value: notifyCh, inline: true },
          { name: `🕐 ${t('dialogue.remote.fields.lastUpdated', lang)}`, value: updated, inline: true },
          { name: `👤 ${t('dialogue.remote.fields.updatedBy', lang)}`, value: gc?.updatedByTag || '-', inline: true },
        )
        .setColor(isOwner ? COLORS.gold : gc ? COLORS.info : COLORS.greyDark);

      // Bot-wide settings only shown on owner guild card
      if (isOwner) {
        const evidenceCh = gc?.evidenceChannelId
          ? `<#${gc.evidenceChannelId}>`
          : `*${t('dialogue.remote.evidenceLegacy', lang)}*`;
        embed.addFields({
          name: `🖼️ ${t('dialogue.remote.fields.evidenceChannel', lang)}`,
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
        new ButtonBuilder().setCustomId('remote_prev').setLabel(`◀ ${t('common.pagination.previous', lang)}`).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId('remote_page').setLabel(`${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('remote_next').setLabel(`${t('common.pagination.next', lang)} ▶`).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
      )];
    }

    const msg = await editPayload(interaction, { embeds: buildPage(0), components: buildNav(0) });

    if (totalPages <= 1) return;

    const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000 });
    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        const clickerLang = await getUserLanguage(i.user.id, { UserPreferenceModel: UserPreference });
        await replyAlert(i, {
          severity: AlertSeverity.ERROR,
          ...t('dialogue.common.notYourSession', clickerLang),
          lang: clickerLang,
        });
        return;
      }
      if (i.customId === 'remote_prev') currentPage = Math.max(0, currentPage - 1);
      else if (i.customId === 'remote_next') currentPage = Math.min(totalPages - 1, currentPage + 1);
      await updatePayload(i, { embeds: buildPage(currentPage), components: buildNav(currentPage) });
    });
    collector.on('end', () => {
      editPayload(interaction, { components: [] }).catch(() => {});
    });
    return;
  }

  // ── ACTION: evidencechannel ──────────────────────────────
  // Bot-wide setting (not per-guild) · stored on owner GuildConfig.
  // Sets where the bot rehosts /la-list add evidence images for permanent storage.
  if (action === 'evidencechannel') {
    if (!config.ownerGuildId) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.remote.configMissing', lang),
        lang,
      });
      return;
    }

    if (!channelOpt) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.remote.channelRequired', lang),
        lang,
      });
      return;
    }

    if (!channelOpt.isTextBased?.()) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.remote.channelWrongType', lang, { channel: channelOpt.id }),
        lang,
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
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          ...t('dialogue.common.missingPermissions', lang, { channel: channelOpt.id }),
          fields: [{ name: t('dialogue.common.missingField', lang), value: missing.join(', '), inline: false }],
          lang,
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

    const embed = createArtistEmbed(lang)
      .setTitle(`🖼️ ${t('dialogue.remote.evidenceUpdated.title', lang)}`)
      .setDescription(t('dialogue.remote.evidenceUpdated.description', lang, { channel: channelOpt.id }))
      .addFields(
        { name: t('dialogue.remote.fields.channel', lang), value: `<#${channelOpt.id}>`, inline: true },
        { name: t('dialogue.remote.fields.channelId', lang), value: `\`${channelOpt.id}\``, inline: true },
        { name: t('dialogue.remote.fields.server', lang), value: channelOpt.guild?.name || `*${t('dialogue.common.unknown', lang)}*`, inline: true },
      )
      .setColor(COLORS.info)
      .setFooter({ text: t('dialogue.remote.evidenceUpdated.footer', lang, { user: interaction.user.tag }) })
      .setTimestamp();

    await editEmbed(interaction, embed);
    console.log(`[la-remote] evidenceChannelId → ${channelOpt.id} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: syncimages ───────────────────────────────────
  if (action === 'syncimages') {
    await handleSyncImagesAction(interaction, lang);
    return;
  }

  // ── Need guild ID for off/defaultscope ───────────────────
  if (!targetGuildId) {
    const helpEmbed = createArtistEmbed(lang)
      .setTitle(`❌ ${t('dialogue.remote.missingGuild.title', lang)}`)
      .setDescription(t('dialogue.remote.missingGuild.description', lang))
      .addFields(
        { name: t('dialogue.remote.missingGuild.toggleNotify', lang), value: '`/la-remote action:off guild:<ID>`', inline: false },
        { name: t('dialogue.remote.missingGuild.setScope', lang), value: '`/la-remote action:defaultscope guild:<ID> scope:server`', inline: false },
        { name: t('dialogue.remote.missingGuild.setEvidence', lang), value: '`/la-remote action:evidencechannel channel:#...`', inline: false },
        { name: t('dialogue.remote.missingGuild.syncImages', lang), value: `\`/la-remote action:syncimages\` (${t('dialogue.remote.missingGuild.noGuildNeeded', lang)})`, inline: false },
      )
      .setColor(COLORS.danger);
    await editEmbed(interaction, helpEmbed);
    return;
  }

  // Validate target guild · bot must be in it
  const guildName = await resolveGuildName(targetGuildId);
  if (!guildName) {
    const embed = createArtistEmbed(lang)
      .setTitle(`❌ ${t('dialogue.remote.guildNotFound.title', lang)}`)
      .setDescription(t('dialogue.remote.guildNotFound.description', lang, { guild: targetGuildId }))
      .setColor(COLORS.danger);
    await editEmbed(interaction, embed);
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

    const stateLabel = t(`dialogue.remote.state.${newState ? 'enabled' : 'disabled'}`, lang);
    const embed = createArtistEmbed(lang)
      .setTitle(`${newState ? '🔔' : '🔕'} ${t('dialogue.remote.notifyTitle', lang, { state: stateLabel })}`)
      .addFields(
        { name: t('dialogue.remote.fields.server', lang), value: `**${guildName}**\n\`${targetGuildId}\``, inline: true },
        { name: t('dialogue.remote.fields.status', lang), value: `${newState ? '🔔' : '🔕'} ${t(`dialogue.remote.state.${newState ? 'receiving' : 'silent'}`, lang)}`, inline: true },
      )
      .setColor(newState ? COLORS.success : COLORS.danger)
      .setFooter({ text: t('dialogue.remote.changedFooter', lang, { user: interaction.user.tag }) })
      .setTimestamp();

    await editEmbed(interaction, embed);
    console.log(`[la-remote] ${targetGuildId} globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
    return;
  }

  // ── ACTION: defaultscope ─────────────────────────────────
  if (action === 'defaultscope') {
    if (!scopeValue) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.remote.scopeRequired', lang),
        lang,
      });
      return;
    }

    await GuildConfig.findOneAndUpdate(
      { guildId: targetGuildId },
      { $set: { defaultBlacklistScope: scopeValue, ...auditFields } },
      { upsert: true, returnDocument: 'after' }
    );
    invalidateGuildConfig(targetGuildId);

    const scopeDisplay = `${scopeValue === 'server' ? '🔒' : '🌐'} ${t(`dialogue.remote.state.${scopeValue === 'server' ? 'local' : 'global'}`, lang)}`;
    const embed = createArtistEmbed(lang)
      .setTitle(`${scopeValue === 'server' ? '🔒' : '🌐'} ${t('dialogue.remote.scopeUpdatedTitle', lang)}`)
      .addFields(
        { name: t('dialogue.remote.fields.server', lang), value: `**${guildName}**\n\`${targetGuildId}\``, inline: true },
        { name: t('dialogue.remote.fields.defaultScope', lang), value: scopeDisplay, inline: true },
      )
      .setColor(scopeValue === 'server' ? COLORS.warning : COLORS.info)
      .setFooter({ text: t('dialogue.remote.changedFooter', lang, { user: interaction.user.tag }) })
      .setTimestamp();

    await editEmbed(interaction, embed);
    console.log(`[la-remote] ${targetGuildId} defaultBlacklistScope → ${scopeValue} by ${interaction.user.tag}`);
  }
}
