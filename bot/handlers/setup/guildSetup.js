/**
 * handlers/setup/guildSetup.js
 * Handles /la-setup command for per-guild channel configuration.
 * Allows server admins to set auto-check and notification channels
 * without needing to modify environment variables.
 */

import { PermissionFlagsBits } from 'discord.js';
import { createArtistEmbed } from '../../utils/artistVoice.js';
import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import UserPreference from '../../models/UserPreference.js';
import { invalidateGuildConfig } from '../../utils/scope.js';
import { COLORS } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import {
  getSupportedLanguages,
  getUserLanguage,
  t,
  setGuildLanguage,
} from '../../services/i18n/index.js';
import { checkBotPermissions } from '../../services/setup/channelPermissions.js';
import { resolveAutoCheckCleanupEnabled } from '../../services/setup/autoCheckCleanupPolicy.js';
import {
  cleanupAndRefreshListNotifyChannel,
  getVietnamHalfHourKey,
} from '../../services/setup/listNotifyCleanup.js';
import {
  deferEphemeralReply,
  editAlert,
  editEmbed,
  editNotice,
} from '../../utils/interactionReplies.js';
import {
  postSetupWelcome,
  postListNotifySetupWelcome,
  reportMissingChannelPermissions,
  requireSetupGuildTextChannel,
  resolveGuildTextChannel,
  resolveListNotifyWelcomePinContext,
  resolveWelcomePinContext,
} from './setupGuards.js';

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
 * Handle the set-auto-channel action
 */
async function handleSetupAutoChannel(interaction, lang) {
  const channel = await requireSetupGuildTextChannel(interaction, lang);
  if (!channel) return;

  await connectDB();
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const cleanupEnabled = resolveAutoCheckCleanupEnabled(existing);

  // Check bot permissions before saving
  const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
    cleanup: cleanupEnabled,
    welcomePin: true,
  });
  if (!ok) {
    await reportMissingChannelPermissions(interaction, lang, channel.id, missing);
    return;
  }

  // Warn if same channel as notify (allow but warn)
  const sameAsNotify = existing?.listNotifyChannelId === channel.id;

  const welcome = await postSetupWelcome(interaction, {
    channel,
    cleanupEnabled,
    configSet: {
      autoCheckChannelId: channel.id,
      autoCheckCleanupEnabled: cleanupEnabled,
      updatedByUserId: interaction.user.id,
      updatedByTag: interaction.user.tag,
    },
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
      cleanup: t(
        `dialogue.setup.autoCleanup.${cleanupEnabled ? 'enabled' : 'disabled'}`,
        lang
      ),
      warning,
      welcome: welcomeOutcomeText(welcome, lang),
    })}`,
    { severity: AlertSeverity.SUCCESS, lang }
  );

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) set autoCheckChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle the set-notify-channel action
 */
async function handleSetupNotifyChannel(interaction, lang) {
  const channel = await requireSetupGuildTextChannel(interaction, lang);
  if (!channel) return;

  await connectDB();

  // Warn if same channel as auto-check (allow but warn), and preserve the
  // notify cleanup opt-in when moving the configured channel.
  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const cleanupEnabled = existing?.listNotifyCleanupEnabled === true;
  const sameAsAutoCheck = existing?.autoCheckChannelId === channel.id;

  // A persistent guide replaces the old transient test message, so pin access
  // is part of a successful setup. Manage Messages is only required when this
  // guild explicitly enabled notify cleanup.
  const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
    cleanup: cleanupEnabled,
    welcomePin: true,
  });
  if (!ok) {
    await reportMissingChannelPermissions(interaction, lang, channel.id, missing);
    return;
  }

  const configSet = {
    listNotifyChannelId: channel.id,
    globalNotifyEnabled: true,
    listNotifyCleanupEnabled: cleanupEnabled,
    updatedByUserId: interaction.user.id,
    updatedByTag: interaction.user.tag,
  };
  if (cleanupEnabled) {
    // Moving an enabled cleaner must not immediately wipe the new channel in
    // the remainder of the current slot.
    configSet.lastListNotifyCleanupKey = getVietnamHalfHourKey();
  }
  const welcome = await postListNotifySetupWelcome(interaction, {
    channel,
    cleanupEnabled,
    configSet,
  });
  if (!welcome.pinned || !welcome.persisted) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.notifyChannelNotSet', lang, {
        channel: channel.id,
        welcome: welcomeOutcomeText(welcome, lang),
      })}`,
      { severity: AlertSeverity.ERROR, lang }
    );
    return;
  }

  const warning = sameAsAutoCheck
    ? `\n⚠️ ${t('dialogue.setup.sameChannelWarning', lang, { other: t('dialogue.setup.purpose.autoCheck', lang) })}`
    : '';

  await editNotice(interaction, `✅ ${t('dialogue.setup.notifyChannelSet', lang, {
    channel: channel.id,
    warning,
    welcome: welcomeOutcomeText(welcome, lang),
    cleanup: t(
      `dialogue.setup.listNotifyCleanup.${cleanupEnabled ? 'enabled' : 'disabled'}`,
      lang
    ),
  })}`, {
    severity: AlertSeverity.SUCCESS,
    lang,
  });

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) set listNotifyChannel → #${channel.name} (${channel.id}) by ${interaction.user.tag}`);
}

/**
 * Handle the notify-on / notify-off action · toggle global notifications
 */
async function handleSetupOff(interaction, lang, targetEnabled) {
  await connectDB();

  const newState = targetEnabled;

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
    await editNotice(interaction, `🔔 ${t('dialogue.setup.notificationsEnabled', lang)}\n${t('dialogue.setup.showHint', lang)}`, {
      severity: AlertSeverity.SUCCESS,
      titleIcon: '🔔',
      lang,
    });
  } else {
    await editNotice(interaction, `🔕 ${t('dialogue.setup.notificationsDisabled', lang)}\n${t('dialogue.setup.showHint', lang)}`, {
      severity: AlertSeverity.INFO,
      titleIcon: '🔕',
      lang,
    });
  }

  invalidateGuildConfig(interaction.guild.id);
  console.log(`[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) globalNotify → ${newState ? 'ON' : 'OFF'} by ${interaction.user.tag}`);
}

/**
 * Handle the cleanup-on / cleanup-off action · destructive cleanup is per guild.
 */
async function handleSetupCleanup(interaction, lang, enabled) {
  await connectDB();

  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const channel = await resolveGuildTextChannel(
    interaction,
    existing?.autoCheckChannelId
  );

  if (enabled && !channel) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.autoCleanup.noChannel', lang)}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  if (enabled) {
    const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
      cleanup: true,
      welcomePin: true,
    });
    if (!ok) {
      await reportMissingChannelPermissions(interaction, lang, channel.id, missing);
      return;
    }
  }

  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    {
      $set: {
        autoCheckCleanupEnabled: enabled,
        updatedByUserId: interaction.user.id,
        updatedByTag: interaction.user.tag,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
  invalidateGuildConfig(interaction.guild.id);

  let guideLine = '';
  if (channel) {
    const pinPermissions = checkBotPermissions(channel, interaction.guild, {
      cleanup: enabled,
      welcomePin: true,
    });
    if (pinPermissions.ok) {
      const welcome = await postSetupWelcome(interaction, {
        channel,
        cleanupEnabled: enabled,
      });
      guideLine = `\n${welcomeOutcomeText(welcome, lang)}`;
    } else {
      guideLine = `\n⚠️ ${t('dialogue.setup.autoCleanup.guideNotRefreshed', lang, {
        missing: pinPermissions.missing.join(', '),
      })}`;
    }
  }

  await editNotice(
    interaction,
    `${enabled ? '🧹' : '🛡️'} ${t(
      `dialogue.setup.autoCleanup.${enabled ? 'enabled' : 'disabled'}`,
      lang
    )}${guideLine}\n${t('dialogue.setup.showHint', lang)}`,
    {
      severity: enabled ? AlertSeverity.SUCCESS : AlertSeverity.INFO,
      lang,
    }
  );

  console.log(
    `[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) autoCheckCleanup → ${enabled ? 'ON' : 'OFF'} by ${interaction.user.tag}`
  );
}

/**
 * Toggle the independent RaidManage-style cleaner for list notifications.
 * Existing guilds remain off until an admin explicitly opts in.
 */
async function handleSetupListNotifyCleanupToggle(interaction, lang, enabled) {
  await connectDB();

  const existing = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();
  const channel = await resolveGuildTextChannel(
    interaction,
    existing?.listNotifyChannelId
  );

  if (enabled && !channel) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.listNotifyCleanup.noChannel', lang)}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  const permissions = channel
    ? checkBotPermissions(channel, interaction.guild, {
        cleanup: enabled,
        welcomePin: true,
      })
    : null;
  if (enabled && !permissions?.ok) {
    await reportMissingChannelPermissions(
      interaction,
      lang,
      channel.id,
      permissions?.missing || []
    );
    return;
  }

  const state = {
    listNotifyCleanupEnabled: enabled,
    updatedByUserId: interaction.user.id,
    updatedByTag: interaction.user.tag,
  };
  if (enabled) {
    // Match RaidManage: enabling arms future slots without deleting the
    // channel immediately during the current half-hour.
    state.lastListNotifyCleanupKey = getVietnamHalfHourKey();
  }
  await GuildConfig.findOneAndUpdate(
    { guildId: interaction.guild.id },
    { $set: state },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  invalidateGuildConfig(interaction.guild.id);

  let guideLine = '';
  if (channel && permissions?.ok) {
    const welcome = await postListNotifySetupWelcome(interaction, {
      channel,
      cleanupEnabled: enabled,
    });
    guideLine = `\n${welcomeOutcomeText(welcome, lang)}`;
  } else if (channel && permissions && !permissions.ok) {
    guideLine = `\n⚠️ ${t('dialogue.setup.listNotifyCleanup.guideNotRefreshed', lang, {
      missing: permissions.missing.join(', '),
    })}`;
  }

  await editNotice(
    interaction,
    `${enabled ? '🧹' : '🛡️'} ${t(
      `dialogue.setup.listNotifyCleanup.${enabled ? 'enabled' : 'disabled'}`,
      lang
    )}${guideLine}\n${t('dialogue.setup.showHint', lang)}`,
    {
      severity: enabled ? AlertSeverity.SUCCESS : AlertSeverity.INFO,
      lang,
    }
  );

  console.log(
    `[la-setup] Guild ${interaction.guild.name} (${interaction.guild.id}) listNotifyCleanup → ${enabled ? 'ON' : 'OFF'} by ${interaction.user.tag}`
  );
}

async function handleSetupListNotifyCleanupNow(interaction, lang) {
  await connectDB();
  const guildConfig = await GuildConfig.findOne({
    guildId: interaction.guild.id,
  }).lean();
  const channel = await resolveGuildTextChannel(
    interaction,
    guildConfig?.listNotifyChannelId
  );
  if (!channel) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.listNotifyCleanup.noChannel', lang)}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  const { ok, missing } = checkBotPermissions(channel, interaction.guild, {
    cleanup: true,
    welcomePin: true,
  });
  if (!ok) {
    await reportMissingChannelPermissions(interaction, lang, channel.id, missing);
    return;
  }

  try {
    const outcome = await cleanupAndRefreshListNotifyChannel(channel, {
      client: interaction.client,
      guildId: interaction.guild.id,
      cleanupEnabled: guildConfig?.listNotifyCleanupEnabled === true,
      protectedMessageIds: [guildConfig?.listNotifyWelcomeMessageId].filter(Boolean),
      postNoticeAfter: false,
    });
    await editNotice(
      interaction,
      `✅ ${t('dialogue.setup.listNotifyCleanup.manualSuccess', lang, {
        channel: channel.id,
        count: outcome.deleted,
      })}`,
      { severity: AlertSeverity.SUCCESS, lang }
    );
  } catch (err) {
    console.error('[la-setup] list notify manual cleanup failed:', err?.message || err);
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.listNotifyCleanup.manualFailed', lang, {
        channel: channel.id,
        count: Number(err?.cleanup?.deleted) || 0,
      })}`,
      { severity: AlertSeverity.ERROR, lang }
    );
  }
}

async function handleSetupListNotifyRepin(interaction, lang) {
  await connectDB();
  const guildConfig = await GuildConfig.findOne({
    guildId: interaction.guild.id,
  }).lean();
  const { cleanupEnabled, channel, permissions } =
    await resolveListNotifyWelcomePinContext(interaction, guildConfig);
  if (!channel) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.listNotifyRepin.noChannel', lang)}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }
  if (!permissions.ok) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.listNotifyRepin.missingPermissions', lang, {
        channel: channel.id,
        missing: permissions.missing.join(', '),
      })}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  const welcome = await postListNotifySetupWelcome(interaction, {
    channel,
    cleanupEnabled,
  });
  await editNotice(
    interaction,
    t('dialogue.setup.listNotifyRepin.result', lang, {
      outcome: welcomeOutcomeText(welcome, lang),
      channel: channel.id,
    }),
    {
      severity: welcome.pinned && welcome.persisted
        ? AlertSeverity.SUCCESS
        : AlertSeverity.WARNING,
      lang,
    }
  );
}

/**
 * Handle the show action (status hub)
 */
async function handleSetupView(interaction, lang) {
  await connectDB();

  const guildConfig = await GuildConfig.findOne({ guildId: interaction.guild.id }).lean();

  const autoCheckDb = guildConfig?.autoCheckChannelId;
  const notifyDb = guildConfig?.listNotifyChannelId;
  const autoCheckEnv = config.autoCheckChannelIds;
  const notifyEnv = config.listNotifyChannelIds;
  const notifyEnabled = guildConfig?.globalNotifyEnabled ?? true;
  const cleanupEnabled = resolveAutoCheckCleanupEnabled(guildConfig);
  const notifyCleanupEnabled = guildConfig?.listNotifyCleanupEnabled === true;
  const defaultScope = guildConfig?.defaultBlacklistScope || 'global';
  const scopeEmoji = defaultScope === 'server' ? '🔒' : '🌐';
  const languageEntry =
    getSupportedLanguages().find((entry) => entry.code === guildConfig?.language) ||
    getSupportedLanguages()[0];
  function welcomePinValue(messageId, channelId, repinAction) {
    return messageId && channelId
      ? '<#' + channelId + '> · ' +
        '[Jump to message](https://discord.com/channels/' +
        interaction.guild.id + '/' + channelId + '/' + messageId + ')'
      : `*${t('dialogue.setup.view.pinMissing', lang, { action: repinAction })}*`;
  }
  const autoWelcomePinValue = welcomePinValue(
    guildConfig?.autoCheckWelcomeMessageId,
    guildConfig?.autoCheckWelcomeChannelId,
    'repin'
  );
  const notifyWelcomePinValue = welcomePinValue(
    guildConfig?.listNotifyWelcomeMessageId,
    guildConfig?.listNotifyWelcomeChannelId,
    'notify-repin'
  );
  const cleanupValue = !autoCheckDb
    ? `*${t('dialogue.setup.view.cleanupNoChannel', lang)}*`
    : cleanupEnabled
      ? t('dialogue.setup.view.cleanupActive', lang, {
        last: guildConfig?.lastAutoCheckCleanupKey || `*${t('dialogue.setup.view.notYet', lang)}*`,
      })
      : t('dialogue.setup.view.cleanupDisabled', lang);
  const notifyCleanupValue = !notifyDb
    ? `*${t('dialogue.setup.view.notifyCleanupNoChannel', lang)}*`
    : notifyCleanupEnabled
      ? t('dialogue.setup.view.notifyCleanupActive', lang, {
        last: guildConfig?.lastListNotifyCleanupKey || `*${t('dialogue.setup.view.notYet', lang)}*`,
      })
      : t('dialogue.setup.view.notifyCleanupDisabled', lang);

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
      name: `🌐 ${t('dialogue.setup.view.publicLanguage', lang)}`,
      value: languageEntry.flag + ' **' + languageEntry.label + '**',
      inline: true,
    },
    {
      name: `🎨 ${t('dialogue.setup.view.autoPinnedWelcome', lang)}`,
      value: autoWelcomePinValue,
      inline: true,
    },
    {
      name: `🧹 ${t('dialogue.setup.view.dailyCleanup', lang)}`,
      value: cleanupValue,
      inline: true,
    },
    {
      name: `${scopeEmoji} ${t('dialogue.setup.view.defaultScope', lang)}`,
      value: `**${defaultScope}**\n*${t('dialogue.setup.view.scopeHint', lang, { scope: defaultScope })}*`,
      inline: true,
    },
    {
      name: `🔔 ${t('dialogue.setup.view.notifyPinnedWelcome', lang)}`,
      value: notifyWelcomePinValue,
      inline: true,
    },
    {
      name: `🧹 ${t('dialogue.setup.view.notifyCleanup', lang)}`,
      value: notifyCleanupValue,
      inline: true,
    },
    {
      name: `📡 ${t('dialogue.setup.view.globalNotifications', lang)}`,
      value: notifyEnabled
        ? `🔔 ${t('dialogue.setup.view.notificationsOn', lang)}`
        : `🔕 ${t('dialogue.setup.view.notificationsOff', lang)}`,
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
  const { cleanupEnabled, channel, permissions } = await resolveWelcomePinContext(
    interaction,
    guildConfig,
  );
  if (!channel) {
    await editNotice(
      interaction,
      `⚠️ ${t('dialogue.setup.repin.noChannel', lang)}`,
      { severity: AlertSeverity.WARNING, lang }
    );
    return;
  }

  const { ok, missing } = permissions;
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

  const welcome = await postSetupWelcome(interaction, {
    channel,
    cleanupEnabled,
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
  const refreshes = [];
  if (guildConfig?.autoCheckChannelId) {
    refreshes.push({
      surface: t('dialogue.setup.purpose.autoCheck', language),
      context: await resolveWelcomePinContext(interaction, guildConfig),
      post: postSetupWelcome,
    });
  }
  if (guildConfig?.listNotifyChannelId) {
    refreshes.push({
      surface: t('dialogue.setup.purpose.notification', language),
      context: await resolveListNotifyWelcomePinContext(interaction, guildConfig),
      post: postListNotifySetupWelcome,
    });
  }

  if (refreshes.length === 0) {
    await editNotice(
      interaction,
      `${prefix}\n${t('dialogue.setup.language.noChannel', language)}`,
      { severity: AlertSeverity.WARNING, titleIcon: '🌐', lang: language }
    );
    return;
  }

  const lines = [];
  let hasWarning = false;
  for (const refresh of refreshes) {
    const { cleanupEnabled, channel, permissions } = refresh.context;
    if (!channel) {
      hasWarning = true;
      lines.push(`⚠️ ${t('dialogue.setup.language.channelUnavailable', language, {
        surface: refresh.surface,
      })}`);
      continue;
    }
    if (!permissions.ok) {
      hasWarning = true;
      lines.push(`⚠️ ${t('dialogue.setup.language.pinFailed', language, {
        channel: channel.id,
        missing: permissions.missing.join(', '),
        surface: refresh.surface,
      })}`);
      continue;
    }

    const welcome = await refresh.post(interaction, {
      channel,
      cleanupEnabled,
    });
    if (!welcome.pinned || !welcome.persisted) hasWarning = true;
    lines.push(t('dialogue.setup.language.pinResult', language, {
      outcome: welcomeOutcomeText(welcome, language),
      channel: channel.id,
      surface: refresh.surface,
    }));
  }

  await editNotice(
    interaction,
    `${prefix}\n${lines.join('\n')}`,
    {
      severity: hasWarning ? AlertSeverity.WARNING : AlertSeverity.SUCCESS,
      titleIcon: '🌐',
      lang: language,
    }
  );
}

// Maps the `action` option of /la-setup config to the handler that runs it.
// The two toggles pass an explicit target state so the action name is the
// source of truth (autocomplete only offers the toggle that changes state).
export const SETUP_ACTION_HANDLERS = {
  'show': (interaction, lang) => handleSetupView(interaction, lang),
  'set-auto-channel': (interaction, lang) => handleSetupAutoChannel(interaction, lang),
  'set-notify-channel': (interaction, lang) => handleSetupNotifyChannel(interaction, lang),
  'set-language': (interaction) => handleSetupLanguage(interaction),
  'set-default-scope': (interaction, lang) => handleSetupDefaultScope(interaction, lang),
  'cleanup-on': (interaction, lang) => handleSetupCleanup(interaction, lang, true),
  'cleanup-off': (interaction, lang) => handleSetupCleanup(interaction, lang, false),
  'notify-cleanup': (interaction, lang) => handleSetupListNotifyCleanupNow(interaction, lang),
  'notify-cleanup-on': (interaction, lang) => handleSetupListNotifyCleanupToggle(interaction, lang, true),
  'notify-cleanup-off': (interaction, lang) => handleSetupListNotifyCleanupToggle(interaction, lang, false),
  'notify-repin': (interaction, lang) => handleSetupListNotifyRepin(interaction, lang),
  'notify-on': (interaction, lang) => handleSetupOff(interaction, lang, true),
  'notify-off': (interaction, lang) => handleSetupOff(interaction, lang, false),
  'repin': (interaction, lang) => handleSetupRepin(interaction, lang),
};

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

  const hasManageGuild = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!hasManageGuild) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.setup.manageGuildRequired', lang),
      lang,
    });
    return;
  }

  const action = interaction.options.getString('action', true);
  const handler = SETUP_ACTION_HANDLERS[action];
  if (handler) await handler(interaction, lang);
}

/**
 * Handle the set-default-scope action
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
