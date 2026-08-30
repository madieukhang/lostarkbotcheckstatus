import GuildConfig from '../../models/GuildConfig.js';
import { getGuildLanguage } from '../i18n/index.js';
import { postCleanupNotice } from './cleanupNotice.js';
import { autoCheckChannelGuard } from './autoCheckChannelGuard.js';
import { checkBotPermissions } from './channelPermissions.js';
import {
  buildAutoCheckCleanupEligibility,
  resolveAutoCheckCleanupEnabled,
} from './autoCheckCleanupPolicy.js';
import {
  cleanupChannelMessages,
  formatCleanupFailureReasons,
} from './channelCleanup.js';
import {
  createCleanupScheduler,
  createIncompleteCleanupError,
  prepareCleanupChannel,
  resolveGuildTextChannel,
} from './cleanupRuntime.js';

// Backward-compatible public name used by the existing auto-check tests and
// welcome service. The implementation is channel-generic so notify cleanup can
// share the same old-message and partial-failure behavior.
export const cleanupAutoCheckChannelMessages = cleanupChannelMessages;
export { formatCleanupFailureReasons };

export const AUTO_CHECK_CLEANUP_TICK_MS = 15 * 60 * 1000;
export const AUTO_CHECK_CLEANUP_TIME_ZONE = 'Asia/Ho_Chi_Minh';

const dayKeyFormatter = new Intl.DateTimeFormat('en', {
  timeZone: AUTO_CHECK_CLEANUP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function getVietnamDayKey(date = new Date()) {
  const parts = Object.fromEntries(
    dayKeyFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return parts.year + '-' + parts.month + '-' + parts.day;
}

async function resolveConfiguredChannel(client, config) {
  return resolveGuildTextChannel(client, {
    channelId: config.autoCheckChannelId,
    guildId: config.guildId,
  });
}

export function createAutoCheckCleanupService({
  GuildConfigModel = GuildConfig,
  cleanupMessages = cleanupAutoCheckChannelMessages,
  nowDate = () => new Date(),
  resolveChannel = resolveConfiguredChannel,
  channelGuard = autoCheckChannelGuard,
  checkPermissions = checkBotPermissions,
  postNotice = postCleanupNotice,
  getGuildLanguageFn = getGuildLanguage,
  logger = console,
} = {}) {
  const cleanupEligibility = buildAutoCheckCleanupEligibility();

  async function releaseClaim(guildId, dayKey) {
    try {
      await GuildConfigModel.findOneAndUpdate(
        { guildId, lastAutoCheckCleanupKey: dayKey },
        { $unset: { lastAutoCheckCleanupKey: 1 } }
      );
    } catch (err) {
      logger.error?.('[auto-check cleanup] claim rollback failed guild=' + guildId + ':', err?.message || err);
    }
  }

  async function runDailyCleanupTick(client) {
    const dayKey = getVietnamDayKey(nowDate());
    let configs;
    try {
      configs = await GuildConfigModel.find({
        ...cleanupEligibility,
        autoCheckChannelId: { $nin: ['', null] },
        lastAutoCheckCleanupKey: { $ne: dayKey },
      }).lean();
    } catch (err) {
      logger.error?.('[auto-check cleanup] config load failed:', err?.message || err);
      return;
    }

    for (const config of configs) {
      if (!resolveAutoCheckCleanupEnabled(config)) {
        continue;
      }

      const channel = await prepareCleanupChannel({
        client,
        config,
        channelId: config.autoCheckChannelId,
        resolveChannel,
        checkPermissions,
        permissionOptions: { cleanup: true },
        logPrefix: '[auto-check cleanup]',
        logger,
      });
      if (!channel) continue;

      try {
        await channelGuard.runExclusive(channel.id, async () => {
          let claimed = false;
          try {
            const claim = await GuildConfigModel.findOneAndUpdate(
              {
                ...cleanupEligibility,
                guildId: config.guildId,
                autoCheckChannelId: config.autoCheckChannelId,
                lastAutoCheckCleanupKey: { $ne: dayKey },
              },
              { $set: { lastAutoCheckCleanupKey: dayKey } },
              { returnDocument: 'after' }
            );
            if (!claim) return;
            claimed = true;

            const protectedMessageIds = [
              config.autoCheckWelcomeMessageId,
              ...channelGuard.getProtectedMessageIds(channel.id),
            ].filter(Boolean);
            const outcome = await cleanupMessages(channel, { protectedMessageIds });
            if (outcome.failed > 0 || outcome.truncated) {
              throw createIncompleteCleanupError(outcome);
            }
            logger.info?.(
              '[auto-check cleanup] guild=' + config.guildId +
              ' day=' + dayKey +
              ' deleted=' + outcome.deleted
            );

            // Leave a sign, otherwise the channel just looks emptied and
            // nobody can tell tidying apart from messages going missing.
            // Posted after the sweep so this run cannot delete its own notice,
            // and left standing until tomorrow's sweep: at 00:00 local time a
            // self-deleting notice would be seen by nobody.
            const lang = await getGuildLanguageFn(config.guildId, { GuildConfigModel });
            await postNotice(channel, outcome.deleted, lang, { logger });
          } catch (err) {
            logger.error?.('[auto-check cleanup] failed guild=' + config.guildId + ':', err?.message || err);
            if (claimed) await releaseClaim(config.guildId, dayKey);
          }
        });
      } catch (err) {
        logger.error?.('[auto-check cleanup] guard failed guild=' + config.guildId + ':', err?.message || err);
      }
    }
  }

  return {
    runDailyCleanupTick,
  };
}

export function createAutoCheckCleanupScheduler({
  cleanupService,
  intervalMs = AUTO_CHECK_CLEANUP_TICK_MS,
  logger = console,
  setIntervalFn = setInterval,
} = {}) {
  return createCleanupScheduler({
    runCleanup: (client) => cleanupService.runDailyCleanupTick(client),
    intervalMs,
    failureLabel: '[auto-check cleanup] unexpected scheduler failure:',
    logger,
    setIntervalFn,
  });
}

const productionCleanupService = createAutoCheckCleanupService();
const productionCleanupScheduler = createAutoCheckCleanupScheduler({
  cleanupService: productionCleanupService,
});

export function startAutoCheckCleanup(client) {
  return productionCleanupScheduler.start(client);
}
