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
import { resolveAutoCheckCleanupEnabled } from '../../services/setup/autoCheckCleanupPolicy.js';
import { handleSyncImagesAction } from './syncImages.js';

const EVIDENCE_CHANNEL_RULES = Object.freeze([
  {
    key: 'dialogue.remote.configMissing',
    invalid: () => !config.ownerGuildId,
  },
  {
    key: 'dialogue.remote.channelRequired',
    invalid: ({ channel }) => !channel,
  },
  {
    key: 'dialogue.remote.channelWrongType',
    invalid: ({ channel }) => !channel.isTextBased?.(),
    vars: ({ channel }) => ({ channel: channel.id }),
  },
]);

function enabledLabel(enabled, lang, { on = '🔔', off = '🔕' } = {}) {
  return `${enabled ? on : off} ${t(`dialogue.remote.state.${enabled ? 'enabled' : 'disabled'}`, lang)}`;
}

export function buildRemoteServerEmbed(guild, guildConfig, { isOwner = false, lang = 'en' } = {}) {
  const scope = guildConfig?.defaultBlacklistScope || 'global';
  const notSet = `*${t('dialogue.remote.notSet', lang)}*`;
  const configured = guildConfig ? '✅' : '⚪';
  const descriptionSuffix = [
    isOwner ? ` · **${t('dialogue.remote.ownerServer', lang)}**` : '',
    !guildConfig ? ` · *${t('dialogue.remote.noConfig', lang)}*` : '',
  ].join('');
  const embed = createArtistEmbed(lang)
    .setTitle(`${isOwner ? '👑' : '🖥️'} ${guild.name} ${configured}`)
    .setDescription(`\`${guild.id}\`${descriptionSuffix}`)
    .addFields(
      {
        name: `📡 ${t('dialogue.remote.fields.globalNotify', lang)}`,
        value: enabledLabel(guildConfig?.globalNotifyEnabled !== false, lang),
        inline: true,
      },
      {
        name: `🎯 ${t('dialogue.remote.fields.defaultScope', lang)}`,
        value: scope === 'server'
          ? `🔒 ${t('dialogue.remote.state.local', lang)}`
          : `🌐 ${t('dialogue.remote.state.global', lang)}`,
        inline: true,
      },
      {
        name: `📸 ${t('dialogue.remote.fields.autoCheck', lang)}`,
        value: guildConfig?.autoCheckChannelId ? `<#${guildConfig.autoCheckChannelId}>` : notSet,
        inline: true,
      },
      {
        name: `🧹 ${t('dialogue.remote.fields.autoCleanup', lang)}`,
        value: enabledLabel(resolveAutoCheckCleanupEnabled(guildConfig), lang, { on: '🧹', off: '🛡️' }),
        inline: true,
      },
      {
        name: `🔔 ${t('dialogue.remote.fields.notifyChannel', lang)}`,
        value: guildConfig?.listNotifyChannelId ? `<#${guildConfig.listNotifyChannelId}>` : notSet,
        inline: true,
      },
      {
        name: `🧹 ${t('dialogue.remote.fields.notifyCleanup', lang)}`,
        value: enabledLabel(guildConfig?.listNotifyCleanupEnabled === true, lang, { on: '🧹', off: '🛡️' }),
        inline: true,
      },
      {
        name: `🕐 ${t('dialogue.remote.fields.lastUpdated', lang)}`,
        value: guildConfig?.updatedAt
          ? `<t:${Math.floor(new Date(guildConfig.updatedAt).getTime() / 1000)}:R>`
          : '-',
        inline: true,
      },
      {
        name: `👤 ${t('dialogue.remote.fields.updatedBy', lang)}`,
        value: guildConfig?.updatedByTag || '-',
        inline: true,
      },
    )
    .setColor(isOwner ? COLORS.gold : guildConfig ? COLORS.info : COLORS.greyDark);
  if (isOwner) {
    embed.addFields({
      name: `🖼️ ${t('dialogue.remote.fields.evidenceChannel', lang)}`,
      value: guildConfig?.evidenceChannelId
        ? `<#${guildConfig.evidenceChannelId}>`
        : `*${t('dialogue.remote.evidenceLegacy', lang)}*`,
      inline: false,
    });
  }
  return embed;
}

function buildRemoteNavigation(page, totalPages, lang) {
  if (totalPages <= 1) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('remote_prev').setLabel(`◀ ${t('common.pagination.previous', lang)}`).setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId('remote_page').setLabel(`${page + 1} / ${totalPages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('remote_next').setLabel(`${t('common.pagination.next', lang)} ▶`).setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  )];
}

async function handleViewAction(interaction, lang) {
  const allGuilds = [...interaction.client.guilds.cache.values()];
  const configs = await GuildConfig.find({}).lean();
  const configMap = new Map(configs.map((guildConfig) => [guildConfig.guildId, guildConfig]));
  if (allGuilds.length === 0) {
    await editEmbed(interaction, createArtistEmbed(lang)
      .setTitle(`🛰️ ${t('dialogue.remote.dashboardTitle', lang)}`)
      .setDescription(`*${t('dialogue.remote.noServers', lang)}*`)
      .setColor(COLORS.greyDark));
    return;
  }

  const buildEmbed = (guild) => buildRemoteServerEmbed(guild, configMap.get(guild.id), {
    isOwner: guild.id === config.ownerGuildId,
    lang,
  });
  const ownerGuild = allGuilds.find((guild) => guild.id === config.ownerGuildId);
  const otherGuilds = allGuilds.filter((guild) => guild.id !== config.ownerGuildId);
  const ownerEmbed = ownerGuild ? buildEmbed(ownerGuild) : null;
  const perPage = 3;
  const totalPages = Math.max(1, Math.ceil(otherGuilds.length / perPage));
  let currentPage = 0;
  const buildPage = (page) => {
    const embeds = ownerEmbed ? [ownerEmbed] : [];
    return embeds.concat(otherGuilds.slice(page * perPage, page * perPage + perPage).map(buildEmbed));
  };
  const msg = await editPayload(interaction, {
    embeds: buildPage(0),
    components: buildRemoteNavigation(0, totalPages, lang),
  });
  if (totalPages <= 1) return;

  const collector = msg.createMessageComponentCollector({ componentType: ComponentType.Button, time: 120_000 });
  collector.on('collect', async (buttonInteraction) => {
    if (buttonInteraction.user.id !== interaction.user.id) {
      const clickerLang = await getUserLanguage(buttonInteraction.user.id, { UserPreferenceModel: UserPreference });
      await replyAlert(buttonInteraction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.common.notYourSession', clickerLang),
        lang: clickerLang,
      });
      return;
    }
    const pageDelta = { remote_prev: -1, remote_next: 1 }[buttonInteraction.customId] || 0;
    currentPage = Math.max(0, Math.min(totalPages - 1, currentPage + pageDelta));
    await updatePayload(buttonInteraction, {
      embeds: buildPage(currentPage),
      components: buildRemoteNavigation(currentPage, totalPages, lang),
    });
  });
  collector.on('end', () => editPayload(interaction, { components: [] }).catch(() => {}));
}

function evidenceChannelValidation(channel, lang) {
  const context = { channel };
  const failedRule = EVIDENCE_CHANNEL_RULES.find(({ invalid }) => invalid(context));
  if (failedRule) {
    return { ...t(failedRule.key, lang, failedRule.vars?.(context)), lang };
  }
  const member = channel.guild?.members?.me;
  if (!member) return null;
  const permissions = channel.permissionsFor(member);
  const required = ['ViewChannel', 'SendMessages', 'AttachFiles', 'ReadMessageHistory'];
  const missing = required.filter((permission) => !permissions?.has(permission));
  if (missing.length === 0) return null;
  return {
    ...t('dialogue.common.missingPermissions', lang, { channel: channel.id }),
    fields: [{ name: t('dialogue.common.missingField', lang), value: missing.join(', '), inline: false }],
    lang,
  };
}

async function handleEvidenceChannelAction(interaction, channel, lang) {
  const validation = evidenceChannelValidation(channel, lang);
  if (validation) {
    await editAlert(interaction, { severity: AlertSeverity.ERROR, ...validation });
    return;
  }
  await GuildConfig.findOneAndUpdate(
    { guildId: config.ownerGuildId },
    { $set: {
      evidenceChannelId: channel.id,
      updatedByUserId: interaction.user.id,
      updatedByTag: interaction.user.tag,
    } },
    { upsert: true, returnDocument: 'after' }
  );
  invalidateGuildConfig(config.ownerGuildId);
  const embed = createArtistEmbed(lang)
    .setTitle(`🖼️ ${t('dialogue.remote.evidenceUpdated.title', lang)}`)
    .setDescription(t('dialogue.remote.evidenceUpdated.description', lang, { channel: channel.id }))
    .addFields(
      { name: t('dialogue.remote.fields.channel', lang), value: `<#${channel.id}>`, inline: true },
      { name: t('dialogue.remote.fields.channelId', lang), value: `\`${channel.id}\``, inline: true },
      { name: t('dialogue.remote.fields.server', lang), value: channel.guild?.name || `*${t('dialogue.common.unknown', lang)}*`, inline: true },
    )
    .setColor(COLORS.info)
    .setFooter({ text: t('dialogue.remote.evidenceUpdated.footer', lang, { user: interaction.user.tag }) })
    .setTimestamp();
  await editEmbed(interaction, embed);
  console.log(`[la-remote] evidenceChannelId → ${channel.id} by ${interaction.user.tag}`);
}

function buildMissingGuildEmbed(lang) {
  return createArtistEmbed(lang)
    .setTitle(`❌ ${t('dialogue.remote.missingGuild.title', lang)}`)
    .setDescription(t('dialogue.remote.missingGuild.description', lang))
    .addFields(
      { name: t('dialogue.remote.missingGuild.toggleNotify', lang), value: '`/la-remote action:off guild:<ID>`', inline: false },
      { name: t('dialogue.remote.missingGuild.setScope', lang), value: '`/la-remote action:defaultscope guild:<ID> scope:server`', inline: false },
      { name: t('dialogue.remote.missingGuild.setEvidence', lang), value: '`/la-remote action:evidencechannel channel:#...`', inline: false },
      { name: t('dialogue.remote.missingGuild.syncImages', lang), value: `\`/la-remote action:syncimages\` (${t('dialogue.remote.missingGuild.noGuildNeeded', lang)})`, inline: false },
    )
    .setColor(COLORS.danger);
}

async function resolveGuildName(interaction, guildId) {
  try {
    return (await interaction.client.guilds.fetch(guildId)).name;
  } catch {
    return null;
  }
}

async function handleNotifyToggle(interaction, guildId, guildName, auditFields, lang) {
  const existing = await GuildConfig.findOne({ guildId });
  const enabled = !(existing?.globalNotifyEnabled ?? true);
  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { globalNotifyEnabled: enabled, ...auditFields } },
    { upsert: true, returnDocument: 'after' }
  );
  invalidateGuildConfig(guildId);
  const stateLabel = t(`dialogue.remote.state.${enabled ? 'enabled' : 'disabled'}`, lang);
  const embed = createArtistEmbed(lang)
    .setTitle(`${enabled ? '🔔' : '🔕'} ${t('dialogue.remote.notifyTitle', lang, { state: stateLabel })}`)
    .addFields(
      { name: t('dialogue.remote.fields.server', lang), value: `**${guildName}**\n\`${guildId}\``, inline: true },
      { name: t('dialogue.remote.fields.status', lang), value: `${enabled ? '🔔' : '🔕'} ${t(`dialogue.remote.state.${enabled ? 'receiving' : 'silent'}`, lang)}`, inline: true },
    )
    .setColor(enabled ? COLORS.success : COLORS.danger)
    .setFooter({ text: t('dialogue.remote.changedFooter', lang, { user: interaction.user.tag }) })
    .setTimestamp();
  await editEmbed(interaction, embed);
  console.log(`[la-remote] ${guildId} globalNotify → ${enabled ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
}

async function handleDefaultScope(interaction, guildId, guildName, scope, auditFields, lang) {
  if (!scope) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.remote.scopeRequired', lang),
      lang,
    });
    return;
  }
  await GuildConfig.findOneAndUpdate(
    { guildId },
    { $set: { defaultBlacklistScope: scope, ...auditFields } },
    { upsert: true, returnDocument: 'after' }
  );
  invalidateGuildConfig(guildId);
  const isLocal = scope === 'server';
  const embed = createArtistEmbed(lang)
    .setTitle(`${isLocal ? '🔒' : '🌐'} ${t('dialogue.remote.scopeUpdatedTitle', lang)}`)
    .addFields(
      { name: t('dialogue.remote.fields.server', lang), value: `**${guildName}**\n\`${guildId}\``, inline: true },
      { name: t('dialogue.remote.fields.defaultScope', lang), value: `${isLocal ? '🔒' : '🌐'} ${t(`dialogue.remote.state.${isLocal ? 'local' : 'global'}`, lang)}`, inline: true },
    )
    .setColor(isLocal ? COLORS.warning : COLORS.info)
    .setFooter({ text: t('dialogue.remote.changedFooter', lang, { user: interaction.user.tag }) })
    .setTimestamp();
  await editEmbed(interaction, embed);
  console.log(`[la-remote] ${guildId} defaultBlacklistScope → ${scope} by ${interaction.user.tag}`);
}
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
  const preGuildActions = {
    view: () => handleViewAction(interaction, lang),
    evidencechannel: () => handleEvidenceChannelAction(interaction, channelOpt, lang),
    syncimages: () => handleSyncImagesAction(interaction, lang),
  };
  const preGuildHandler = preGuildActions[action];
  if (preGuildHandler) {
    await preGuildHandler();
    return;
  }
  if (!targetGuildId) {
    await editEmbed(interaction, buildMissingGuildEmbed(lang));
    return;
  }
  const guildName = await resolveGuildName(interaction, targetGuildId);
  if (!guildName) {
    await editEmbed(interaction, createArtistEmbed(lang)
      .setTitle(`❌ ${t('dialogue.remote.guildNotFound.title', lang)}`)
      .setDescription(t('dialogue.remote.guildNotFound.description', lang, { guild: targetGuildId }))
      .setColor(COLORS.danger));
    return;
  }
  const auditFields = { updatedByUserId: interaction.user.id, updatedByTag: interaction.user.tag };
  const guildActions = {
    off: () => handleNotifyToggle(interaction, targetGuildId, guildName, auditFields, lang),
    defaultscope: () => handleDefaultScope(
      interaction,
      targetGuildId,
      guildName,
      scopeValue,
      auditFields,
      lang
    ),
  };
  await guildActions[action]?.();
}
