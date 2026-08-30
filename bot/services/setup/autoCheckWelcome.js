import { EmbedBuilder } from 'discord.js';

import GuildConfig from '../../models/GuildConfig.js';
import {
  getGuildLanguage,
  getSupportedLanguages,
  t,
} from '../i18n/index.js';
import { getVietnamDayKey } from './autoCheckCleanup.js';
import { autoCheckChannelGuard } from './autoCheckChannelGuard.js';
import {
  cleanupChannelMessages,
  formatCleanupFailureReasons,
} from './channelCleanup.js';
import { createPinnedWelcomeService } from './pinnedWelcome.js';
import { COLORS } from '../../utils/ui.js';

function asText(value) {
  return Array.isArray(value) ? value.join('\n') : String(value || '');
}

export function buildAutoCheckWelcomeEmbed(lang, { cleanupEnabled = false } = {}) {
  const cleanupKey = cleanupEnabled ? 'cleanup' : 'cleanupDisabled';
  return new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(t('autoCheckWelcome.title', lang))
    .setDescription(asText(t('autoCheckWelcome.description', lang)))
    .addFields(
      {
        name: t('autoCheckWelcome.howName', lang),
        value: asText(t('autoCheckWelcome.howValue', lang)),
      },
      {
        name: t('autoCheckWelcome.listsName', lang),
        value: asText(t('autoCheckWelcome.listsValue', lang)),
      },
      {
        name: t('autoCheckWelcome.scopeName', lang),
        value: asText(t('autoCheckWelcome.scopeValue', lang)),
      },
      {
        name: t(`autoCheckWelcome.${cleanupKey}Name`, lang),
        value: asText(t(`autoCheckWelcome.${cleanupKey}Value`, lang)),
      },
      {
        name: t('autoCheckWelcome.quickAddName', lang),
        value: asText(t('autoCheckWelcome.quickAddValue', lang)),
      },
      {
        name: t('autoCheckWelcome.commandsName', lang),
        value: asText(t('autoCheckWelcome.commandsValue', lang)),
      }
    )
    .setFooter({ text: t('autoCheckWelcome.footer', lang) });
}

export function createAutoCheckWelcomeService({
  GuildConfigModel = GuildConfig,
  buildWelcomeEmbed = buildAutoCheckWelcomeEmbed,
  getGuildLanguageFn = getGuildLanguage,
  cleanupMessages = cleanupChannelMessages,
  getCleanupDayKey = getVietnamDayKey,
  channelGuard = autoCheckChannelGuard,
  supportedLanguageCodes = getSupportedLanguages().map((entry) => entry.code),
  logger = console,
} = {}) {
  async function beforeSend({ channel, options, outcome, pinState }) {
    if (
      options.cleanupEnabled &&
      outcome.pinScanSucceeded &&
      !outcome.hadOwnedWelcomePin
    ) {
      outcome.cleanupAttempted = true;
      try {
        const cleanup = await cleanupMessages(channel, {
          protectedMessageIds: pinState.pinnedMessageIds,
        });
        outcome.cleanupDeleted = Number(cleanup?.deleted) || 0;
        outcome.cleanupFailed = Number(cleanup?.failed) || 0;
        outcome.cleanupTruncated = Boolean(cleanup?.truncated);
        outcome.cleanupFailureReasons = cleanup?.failureReasons || {};
        outcome.cleanupComplete = outcome.cleanupFailed === 0 && !outcome.cleanupTruncated;
        if (!outcome.cleanupComplete) {
          const failureSummary = formatCleanupFailureReasons(outcome.cleanupFailureReasons);
          logger.warn?.(
            '[auto-check welcome] initial cleanup incomplete: deleted=' + outcome.cleanupDeleted +
            ' failed=' + outcome.cleanupFailed +
            ' truncated=' + outcome.cleanupTruncated +
            (failureSummary ? ' errors=' + failureSummary : '')
          );
        }
      } catch (err) {
        outcome.cleanupFailed = 1;
        logger.warn?.('[auto-check welcome] initial cleanup failed:', err?.message || err);
      }
    }

    return outcome.cleanupComplete
      ? { lastAutoCheckCleanupKey: getCleanupDayKey() }
      : {};
  }

  const service = createPinnedWelcomeService({
    GuildConfigModel,
    buildWelcomeEmbed: (lang, options) => buildWelcomeEmbed(lang, {
      cleanupEnabled: Boolean(options?.cleanupEnabled),
    }),
    getGuildLanguageFn,
    channelGuard,
    supportedLanguageCodes,
    messageIdField: 'autoCheckWelcomeMessageId',
    channelIdField: 'autoCheckWelcomeChannelId',
    logLabel: 'auto-check welcome',
    logger,
    createOutcome: () => ({
      cleanupAttempted: false,
      cleanupComplete: false,
      cleanupDeleted: 0,
      cleanupFailed: 0,
      cleanupTruncated: false,
      cleanupFailureReasons: {},
    }),
    beforeSend,
  });

  return {
    postWelcome: service.postWelcome,
  };
}

const productionWelcomeService = createAutoCheckWelcomeService();

export function postAutoCheckWelcome(options) {
  return productionWelcomeService.postWelcome(options);
}
