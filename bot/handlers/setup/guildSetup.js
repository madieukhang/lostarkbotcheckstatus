/**
 * handlers/setup/guildSetup.js
 * Handles /la-setup command for per-guild channel configuration.
 * Allows server admins to set auto-check and notification channels
 * without needing to modify environment variables.
 */

import { ChannelType } from 'discord.js';
import { createArtistEmbed } from '../../utils/artistVoice.js';
import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import UserPreference from '../../models/UserPreference.js';
import { invalidateGuildConfig } from '../../utils/scope.js';
import { COLORS } from '../../utils/ui.js';
import { AlertSeverity, buildNoticeEmbed } from '../../utils/alertEmbed.js';
import {
  getSupportedLanguages,
  getUserLanguage,
  t,
  setGuildLanguage,
} from '../../services/i18n/index.js';
import { postAutoCheckWelcome } from '../../services/setup/autoCheckWelcome.js';
import { checkBotPermissions } from '../../services/setup/channelPermissions.js';
import {
  deferEphemeralReply,
  editAlert,
  editEmbed,
  editNotice,
} from '../../utils/interactionReplies.js';

/**
 * Send a test message to verify the channel is working.
 * @param {import('discord.js').TextChannel} channel
 * @param {string} purpose - "auto-check" or "notification"
 * @returns {Promise<boolean>}
 */
async function sendTestMessage(channel, purpose, lang) {
  try {
    const msg = await channel.send({
      embeds: [buildNoticeEmbed(t('dialogue.setup.testMessage', lang, { purpose }), {
        severity: AlertSeverity.INFO,
        titleIcon: '🧪',
        lang,
      })],
    });
    // Auto-delete test message after 30 seconds to keep channel clean
    setTimeout(() => msg.delete().catch(() => {}), 30_000);
    return true;
  } catch {
    return false;
  }
}

async function resolveGuildTextChannel(interaction, channelId) {
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

export function welcomeOutcomeText(outcome, lang) {
  const cleanupLine = outcome?.cleanupAttempted
    ? outcome.cleanupComplete
      ? `🧹 ${t('dialogue.setup.welcomeCleaned', lang, { count: outcome.cleanupDeleted })}`
      : `⚠️ ${t('dialogue.setup.welcomeCleanupIncomplete', lang, { count: outcome.cleanupDeleted })}`
    : '';
  if (outcome?.pinned && outcome?.persisted) {
    const pinLine = `🎨 ${t('dialogue.setup.welcomePinned', lang)}` +
      (outcome.removedOldCount > 0
        ? ` · ${t('dialogue.setup.welcomeReplaced', lang, { count: outcome.removedOldCount })}`
        : '');
    return [pinLine, cleanupLine].filter(Boolean).join('\n');
  }
  const failureKey = outcome?.hadOwnedWelcomePin
    ? 'dialogue.setup.welcomeFailed'
    : 'dialogue.setup.welcomeCreateFailed';
  return [cleanupLine, `⚠️ ${t(failureKey, lang)}`].filter(Boolean).join('\n');
}

/**
 * Handle /la-setup autochannel #channel
 */
async function handleSetupAutoChannel(interaction, lang) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.wrongTextChannel', lang),
      lang,
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
    welcomePin: true,
  });
  if (!ok) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.missingPermissions', lang, { channel: channel.id }),
      fields: [{
        name: t('dialogue.common.missingField', lang),
        value: missing.map((m) => `• ${m}`).join('\n'),
        inline: false,
      }],
      lang,
    });
    return;
  }

  await connectDB();

  // Warn if same channel as notify (allow but warn)
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const sameAsNotify = existing?.listNotifyChannelId === channel.id;

  const welcome = await postAutoCheckWelcome({
    botUserId: interaction.client.user.id,
    channel,
    client: interaction.client,
    configSet: {
      autoCheckChannelId: channel.id,
      updatedByUserId: interaction.user.id,
      updatedByTag: interaction.user.tag,
    },
    guildId: interaction.guild.id,
  });

  if (!welcome.pinned || !welcome.persisted) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.autoChannelNotSet', lang, {
        channel: channel.id,
        welcome: welcomeOutcomeText(welcome, lang),
      })}`,
      { severity: AlertSeverity.ERROR, lang }
    );
    return;
  }

  const warning = sameAsNotify
    ? `\n⚠️ ${t('dialogue.setup.sameChannelWarning', lang, { other: t('dialogue.setup.purpose.notification', lang) })}`
    : '';

  await editNotice(
    interaction,
    `✅ ${t('dialogue.setup.autoChannelSet', lang, {
      channel: channel.id,
      warning,
      welcome: welcomeOutcomeText(welcome, lang),
    })}`,
    { severity: AlertSeverity.SUCCESS, lang }
  );

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) set autoCheckChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /la-setup notifychannel #channel
 */
async function handleSetupNotifyChannel(interaction, lang) {
  const channel = interaction.options.getChannel('channel', true);

  if (channel.type !== ChannelType.GuildText) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.wrongTextChannel', lang),
      lang,
    });
    return;
  }

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild);
  if (!ok) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.missingPermissions', lang, { channel: channel.id }),
      fields: [{
        name: t('dialogue.common.missingField', lang),
        value: missing.map((m) => `• ${m}`).join('\n'),
        inline: false,
      }],
      lang,
    });
    return;
  }

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
  const testOk = await sendTestMessage(
    channel,
    t('dialogue.setup.purpose.notification', existing?.language || lang),
    existing?.language || lang,
  );
  const warning = sameAsAutoCheck
    ? `\n⚠️ ${t('dialogue.setup.sameChannelWarning', lang, { other: t('dialogue.setup.purpose.autoCheck', lang) })}`
    : '';

  await editNotice(interaction, `✅ ${t(
    testOk ? 'dialogue.setup.notifyChannelSet' : 'dialogue.setup.notifyChannelSetTestFailed',
    lang,
    { channel: channel.id, warning },
  )}`, {
    severity: testOk ? AlertSeverity.SUCCESS : AlertSeverity.WARNING,
    lang,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) set listNotifyChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle /la-setup off · toggle global notifications on/off
 */
async function handleSetupOff(interaction, lang) {
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
    await editNotice(interaction, `🔔 ${t('dialogue.setup.notificationsEnabled', lang)}`, {
      severity: AlertSeverity.SUCCESS,
      titleIcon: '🔔',
      lang,
    });
  } else {
    await editNotice(interaction, `🔕 ${t('dialogue.setup.notificationsDisabled', lang)}`, {
      severity: AlertSeverity.INFO,
      titleIcon: '🔕',
      lang,
    });
  }

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
}

/**
 * Handle /la-setup view
 */
async function handleSetupView(interaction, lang) {
  await connectDB();

  const guildConfig = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();

  const autoCheckDb = guildConfig?.autoCheckChannelId;
  const notifyDb = guildConfig?.listNotifyChannelId;
  const autoCheckEnv = config.autoCheckChannelIds;
  const notifyEnv = config.listNotifyChannelIds;
  const notifyEnabled = guildConfig?.globalNotifyEnabled ?? true;
  const defaultScope = guildConfig?.defaultBlacklistScope || 'global';
  const scopeEmoji = defaultScope === 'server' ? '🔒' : '🌐';
  const languageEntry =
    getSupportedLanguages().find((entry) => entry.code === guildConfig?.language) ||
    getSupportedLanguages()[0];
  const welcomePinValue =
    guildConfig?.autoCheckWelcomeMessageId &&
    guildConfig?.autoCheckWelcomeChannelId
      ? '<#' + guildConfig.autoCheckWelcomeChannelId + '> · ' +
        '[Jump to message](https://discord.com/channels/' +
        interaction.guild.id + '/' +
        guildConfig.autoCheckWelcomeChannelId + '/' +
        guildConfig.autoCheckWelcomeMessageId + ')'
      : `*${t('dialogue.setup.view.pinMissing', lang)}*`;
  const cleanupValue = autoCheckDb
    ? t('dialogue.setup.view.cleanupActive', lang, {
        last: guildConfig?.lastAutoCheckCleanupKey || `*${t('dialogue.setup.view.notYet', lang)}*`,
      })
    : `*${t('dialogue.setup.view.cleanupInactive', lang)}*`;

  // Each setting renders as its own field so the dashboard reads as a
  // compact grid of "what's configured here?" cards instead of a wall of
  // bullet points. The source qualifier (set via /la-setup vs env var
  // fallback vs not configured) goes on a second line in italics so
  // an admin scanning the grid can tell at a glance how each value
  // was provisioned.
  function channelFieldValue(dbId, envIds) {
    if (dbId) return `<#${dbId}>\n*${t('dialogue.setup.view.setViaSetup', lang)}*`;
    if (envIds.length > 0) return `${envIds.map((id) => `<#${id}>`).join(', ')}\n*${t('dialogue.setup.view.fromEnv', lang)}*`;
    return `*${t('dialogue.setup.view.notConfigured', lang)}*`;
  }

  const fields = [
    {
      name: `📸 ${t('dialogue.setup.view.autoChannel', lang)}`,
      value: channelFieldValue(autoCheckDb, autoCheckEnv),
      inline: true,
    },
    {
      name: `🔔 ${t('dialogue.setup.view.notifyChannel', lang)}`,
      value: channelFieldValue(notifyDb, notifyEnv),
      inline: true,
    },
    {
      name: '​',
      value: '​',
      inline: true,
    },
    {
      name: `${scopeEmoji} ${t('dialogue.setup.view.defaultScope', lang)}`,
      value: `**${defaultScope}**\n*${t('dialogue.setup.view.scopeHint', lang, { scope: defaultScope })}*`,
      inline: true,
    },
    {
      name: `📡 ${t('dialogue.setup.view.globalNotifications', lang)}`,
      value: notifyEnabled
        ? `🔔 ${t('dialogue.setup.view.notificationsOn', lang)}`
        : `🔕 ${t('dialogue.setup.view.notificationsOff', lang)}`,
      inline: true,
    },
    {
      name: '​',
      value: '​',
      inline: true,
    },
    {
      name: `🎨 ${t('dialogue.setup.view.pinnedWelcome', lang)}`,
      value: welcomePinValue,
      inline: true,
    },
    {
      name: `🧹 ${t('dialogue.setup.view.dailyCleanup', lang)}`,
      value: cleanupValue,
      inline: true,
    },
    {
      name: `🌐 ${t('dialogue.setup.view.publicLanguage', lang)}`,
      value: languageEntry.flag + ' **' + languageEntry.label + '**',
      inline: true,
    },
  ];

  const footerParts = [];
  if (guildConfig?.updatedAt) {
    const updatedAtUnix = Math.floor(new Date(guildConfig.updatedAt).getTime() / 1000);
    footerParts.push(t('dialogue.setup.view.lastUpdated', lang, {
      user: guildConfig.updatedByTag || t('dialogue.common.unknown', lang),
      time: `<t:${updatedAtUnix}:R>`,
    }));
  } else {
    footerParts.push(t('dialogue.setup.view.noPersisted', lang));
  }

  const embed = createArtistEmbed(lang)
    .setAuthor({ name: t('dialogue.setup.view.author', lang, { guild: interaction.guild.name }) })
    .setDescription(t('dialogue.setup.view.description', lang))
    .addFields(fields)
    .setColor(COLORS.info)
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  await editEmbed(interaction, embed);
}

async function handleSetupRepin(interaction, lang) {
  await connectDB();

  const guildConfig = await GuildConfig.findOne({
    guildId: interaction.guild.id,
  }).lean();
  const channel = await resolveGuildTextChannel(
    interaction,
    guildConfig?.autoCheckChannelId
  );
  if (!channel) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.repin.noChannel', lang)}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
    welcomePin: true,
  });
  if (!ok) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.repin.missingPermissions', lang, {
        channel: channel.id,
        missing: missing.join(', '),
      })}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  const welcome = await postAutoCheckWelcome({
    botUserId: interaction.client.user.id,
    channel,
    client: interaction.client,
    guildId: interaction.guild.id,
  });
  await editNotice(
    interaction,
    t('dialogue.setup.repin.result', lang, {
      outcome: welcomeOutcomeText(welcome, lang),
      channel: channel.id,
    }),
    { severity: AlertSeverity.SUCCESS, lang }
  );
}

async function handleSetupLanguage(interaction) {
  const requested = interaction.options.getString('language', true);
  await connectDB();

  const language = await setGuildLanguage(interaction.guild.id, requested, {
    GuildConfigModel: GuildConfig,
  });
  const guildConfig = await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  ).lean();
  invalidateGuildConfig(interaction.guild.id);

  const languageEntry =
    getSupportedLanguages().find((entry) => entry.code === language) ||
    getSupportedLanguages()[0];
  const prefix = `🌐 ${t('dialogue.setup.language.set', language, {
    flag: languageEntry.flag,
    label: languageEntry.label,
  })}`;
  const channel = await resolveGuildTextChannel(
    interaction,
    guildConfig?.autoCheckChannelId
  );
  if (!channel) {
    await editNotice(
      interaction,
      `${prefix}\n${t('dialogue.setup.language.noChannel', language)}`,
      { severity: AlertSeverity.WARNING, titleIcon: '🌐', lang: language }
    );
    return;
  }

  const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
    welcomePin: true,
  });
  if (!ok) {
    await editNotice(
      interaction,
      `${prefix}\n⚠️ ${t('dialogue.setup.language.pinFailed', language, {
        channel: channel.id,
        missing: missing.join(', '),
      })}`,
      { severity: AlertSeverity.WARNING, titleIcon: '🌐', lang: language }
    );
    return;
  }

  const welcome = await postAutoCheckWelcome({
    botUserId: interaction.client.user.id,
    channel,
    client: interaction.client,
    guildId: interaction.guild.id,
  });
  await editNotice(
    interaction,
    `${prefix}\n${t('dialogue.setup.language.pinResult', language, {
      outcome: welcomeOutcomeText(welcome, language),
      channel: channel.id,
    })}`,
    { severity: AlertSeverity.SUCCESS, titleIcon: '🌐', lang: language }
  );
}

export async function handleSetupCommand(interaction) {
  await deferEphemeralReply(interaction);
  const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });
  if (!interaction.guild) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.common.serverOnly', lang),
      lang,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  // Remote is senior-only (checked inside handler). All others need ManageGuild.
  if (subcommand !== 'remote') {
    const hasManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
    if (!hasManageGuild) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.setup.manageGuildRequired', lang),
        lang,
      });
      return;
    }
  }

  if (subcommand === 'autochannel') {
    await handleSetupAutoChannel(interaction, lang);
  } else if (subcommand === 'notifychannel') {
    await handleSetupNotifyChannel(interaction, lang);
  } else if (subcommand === 'off') {
    await handleSetupOff(interaction, lang);
  } else if (subcommand === 'defaultscope') {
    await handleSetupDefaultScope(interaction, lang);
  } else if (subcommand === 'view') {
    await handleSetupView(interaction, lang);
  } else if (subcommand === 'repin') {
    await handleSetupRepin(interaction, lang);
  } else if (subcommand === 'language') {
    await handleSetupLanguage(interaction);
  }
}

/**
 * Handle /la-setup defaultscope global|server
 */
async function handleSetupDefaultScope(interaction, lang) {
  const scope = interaction.options.getString('scope', true);

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
  await editNotice(interaction, `${emoji} ${t('dialogue.setup.defaultScopeSet', lang, { scope })}`, {
    severity: AlertSeverity.SUCCESS,
    titleIcon: emoji,
    lang,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) defaultBlacklistScope → ${scope} by ${interaction.user.tag}`);
}
