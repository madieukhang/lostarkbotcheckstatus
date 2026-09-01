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

export function buildListNotifyWelcomeEmbed(lang, { cleanupEnabled = false } = {}) {
  const cleanupKey = cleanupEnabled ? 'cleanup' : 'cleanupDisabled';
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(t('listNotifyWelcome.title', lang))
    .setDescription(asText(t('listNotifyWelcome.description', lang)))
    .addFields(
      {
        name: t('listNotifyWelcome.activityName', lang),
        value: asText(t('listNotifyWelcome.activityValue', lang)),
      },
      {
        name: t('listNotifyWelcome.scopeName', lang),
        value: asText(t('listNotifyWelcome.scopeValue', lang)),
      },
      {
        name: t(`listNotifyWelcome.${cleanupKey}Name`, lang),
        value: asText(t(`listNotifyWelcome.${cleanupKey}Value`, lang)),
      },
      {
        name: t('listNotifyWelcome.commandsName', lang),
        value: asText(t('listNotifyWelcome.commandsValue', lang)),
      }
    )
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
  const service = createPinnedWelcomeService({
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

  return service;
}

const productionWelcomeService = createListNotifyWelcomeService();

export function postListNotifyWelcome(options) {
  return productionWelcomeService.postWelcome(options);
}

export function postListNotifyWelcomeLocked(options) {
  return productionWelcomeService.postWelcomeLocked(options);
}
