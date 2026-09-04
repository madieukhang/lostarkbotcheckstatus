import { EmbedBuilder } from 'discord.js';

import GuildConfig from '../../models/GuildConfig.js';
import {
  getGuildLanguage,
  getSupportedLanguages,
  t,
} from '../i18n/index.js';
import { COLORS } from '../../utils/ui.js';
import { channelLifecycleGuard } from './channelLifecycleGuard.js';
import { createPinnedWelcomeService } from './pinnedWelcome.js';

function asText(value) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}

/**
 * Build the notification pin with the channel's retained/cleanup instructions.
 * @param {string} lang
 * @param {{cleanupEnabled?: boolean}} [options]
 * @returns {EmbedBuilder}
 */
export function buildListNotifyWelcomeEmbed(lang, { cleanupEnabled = false } = {}) {
  const cleanupKey = cleanupEnabled ? 'cleanup' : 'cleanupDisabled';
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(t('listNotifyWelcome.title', lang))
    .setDescription(asText(t('listNotifyWelcome.description', lang)))
    .addFields(['activity', 'scope', cleanupKey, 'commands'].map(key => ({
      name: t(`listNotifyWelcome.${key}Name`, lang),
      value: asText(t(`listNotifyWelcome.${key}Value`, lang)),
    })))
    .setFooter({ text: t('listNotifyWelcome.footer', lang) });
}

export function createListNotifyWelcomeService({
  GuildConfigModel = GuildConfig,
  buildWelcomeEmbed = buildListNotifyWelcomeEmbed,
  getGuildLanguageFn = getGuildLanguage,
  channelGuard = channelLifecycleGuard,
  supportedLanguageCodes = getSupportedLanguages().map((entry) => entry.code),
  logger = console,
} = {}) {
  return createPinnedWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang, options) => buildWelcomeEmbed(lang, {
      cleanupEnabled: Boolean(options?.cleanupEnabled),
    }),
    getGuildLanguageFn,
    channelGuard,
    supportedLanguageCodes,
    messageIdField: 'listNotifyWelcomeMessageId',
    channelIdField: 'listNotifyWelcomeChannelId',
    logLabel: 'list-notify welcome',
    logger,
  });
}

const productionWelcomeService = createListNotifyWelcomeService();

export function postListNotifyWelcome(options) {
  return productionWelcomeService.postWelcome(options);
}

export function postListNotifyWelcomeLocked(options) {
  return productionWelcomeService.postWelcomeLocked(options);
}
