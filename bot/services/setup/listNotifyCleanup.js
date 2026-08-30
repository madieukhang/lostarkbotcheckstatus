import GuildConfig from '../../models/GuildConfig.js';
import { getGuildLanguage } from '../i18n/index.js';
import {
  cleanupChannelMessages,
} from './channelCleanup.js';
import { checkBotPermissions } from './channelPermissions.js';
import {
  createCleanupScheduler,
  createIncompleteCleanupError,
  prepareCleanupChannel,
  resolveGuildTextChannel,
} from './cleanupRuntime.js';
import { listNotifyChannelGuard } from './listNotifyChannelGuard.js';
import { postListNotifyCleanupNotice } from './listNotifyCleanupNotice.js';
import { postListNotifyWelcomeLocked } from './listNotifyWelcome.js';

export const LIST_NOTIFY_CLEANUP_TICK_MS = 30 * 60 * 1000;

/** Asia/Ho_Chi_Minh half-hour cursor, matching RaidManage's cleanup cadence. */
export function getVietnamHalfHourKey(date = new Date()) {
  const local = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const hour = local.toISOString().slice(0, 13);
  const minute = local.getUTCMinutes() < 30 ? '00' : '30';
  return hour + ':' + minute;
}

async function resolveConfiguredChannel(client, config) {
  return resolveGuildTextChannel(client, {
    channelId: config.listNotifyChannelId,
    guildId: config.guildId,
  });
}

function incompleteCleanupError(outcome) {
  return createIncompleteCleanupError(outcome, {
    code: 'LIST_NOTIFY_CLEANUP_INCOMPLETE',
  });
}

export function createListNotifyCleanupService({
  GuildConfigModel = GuildConfig,
  cleanupMessages = cleanupChannelMessages,
  postWelcomeLocked = postListNotifyWelcomeLocked,
  postNotice = postListNotifyCleanupNotice,
  getGuildLanguageFn = getGuildLanguage,
  nowDate = () => new Date(),
  resolveChannel = resolveConfiguredChannel,
  channelGuard = listNotifyChannelGuard,
  checkPermissions = checkBotPermissions,
  logger = console,
} = {}) {
  async function releaseClaim(guildId, slotKey) {
    try {
      await GuildConfigModel.findOneAndUpdate(
        { guildId, lastListNotifyCleanupKey: slotKey },
        { $unset: { lastListNotifyCleanupKey: 1 } }
      );
    } catch (err) {
      logger.error?.(
        '[list-notify cleanup] claim rollback failed guild=' + guildId + ':',
        err?.message || err
      );
    }
  }

  async function cleanupAndRefreshLocked(channel, {
    client,
    guildId,
    cleanupEnabled,
    protectedMessageIds = [],
    postNoticeAfter = false,
  }) {
    const protectedIds = [
      ...protectedMessageIds,
      ...channelGuard.getProtectedMessageIds(channel.id),
    ].filter(Boolean);
    const cleanup = await cleanupMessages(channel, {
      protectedMessageIds: protectedIds,
    });
    if ((Number(cleanup?.failed) || 0) > 0 || cleanup?.truncated) {
      throw incompleteCleanupError(cleanup);
    }

    const welcome = await postWelcomeLocked({
      botUserId: client.user.id,
      channel,
      client,
      cleanupEnabled,
      guildId,
    });
    if (!welcome?.pinned || !welcome?.persisted) {
      const err = new Error('welcome refresh failed after list-notify cleanup');
      err.code = 'LIST_NOTIFY_WELCOME_REFRESH_FAILED';
      err.cleanup = cleanup;
      err.welcome = welcome;
      throw err;
    }

    if (postNoticeAfter) {
      const lang = await getGuildLanguageFn(guildId, {
        GuildConfigModel,
      });
      await postNotice(channel, cleanup.deleted, lang, { logger });
    }

    return { ...cleanup, welcome };
  }

  async function cleanupAndRefreshListNotifyChannel(channel, options) {
    return channelGuard.runExclusive(
      channel?.id,
      () => cleanupAndRefreshLocked(channel, options)
    );
  }

  async function runScheduledCleanupTick(client) {
    const slotKey = getVietnamHalfHourKey(nowDate());
    let configs;
    try {
      configs = await GuildConfigModel.find({
        listNotifyCleanupEnabled: true,
        listNotifyChannelId: { $nin: ['', null] },
        lastListNotifyCleanupKey: { $ne: slotKey },
      }).lean();
    } catch (err) {
      logger.error?.('[list-notify cleanup] config load failed:', err?.message || err);
      return;
    }

    for (const config of configs) {
      const channel = await prepareCleanupChannel({
        client,
        config,
        channelId: config.listNotifyChannelId,
        resolveChannel,
        checkPermissions,
        permissionOptions: { cleanup: true, welcomePin: true },
        logPrefix: '[list-notify cleanup]',
        logger,
      });
      if (!channel) continue;

      try {
        await channelGuard.runExclusive(channel.id, async () => {
          let claimed = false;
          try {
            const claim = await GuildConfigModel.findOneAndUpdate(
              {
                guildId: config.guildId,
                listNotifyCleanupEnabled: true,
                listNotifyChannelId: config.listNotifyChannelId,
                lastListNotifyCleanupKey: { $ne: slotKey },
              },
              { $set: { lastListNotifyCleanupKey: slotKey } },
              { returnDocument: 'after' }
            );
            if (!claim) return;
            claimed = true;

            const outcome = await cleanupAndRefreshLocked(channel, {
              client,
              guildId: config.guildId,
              cleanupEnabled: true,
              protectedMessageIds: [config.listNotifyWelcomeMessageId],
              postNoticeAfter: true,
            });
            logger.info?.(
              '[list-notify cleanup] guild=' + config.guildId +
              ' slot=' + slotKey +
              ' deleted=' + outcome.deleted
            );
          } catch (err) {
            logger.error?.(
              '[list-notify cleanup] failed guild=' + config.guildId + ':',
              err?.message || err
            );
            if (claimed) await releaseClaim(config.guildId, slotKey);
          }
        });
      } catch (err) {
        logger.error?.(
          '[list-notify cleanup] guard failed guild=' + config.guildId + ':',
          err?.message || err
        );
      }
    }
  }

  return {
    cleanupAndRefreshListNotifyChannel,
    runScheduledCleanupTick,
  };
}

export function createListNotifyCleanupScheduler({
  cleanupService,
  intervalMs = LIST_NOTIFY_CLEANUP_TICK_MS,
  logger = console,
  setIntervalFn = setInterval,
} = {}) {
  return createCleanupScheduler({
    runCleanup: (client) => cleanupService.runScheduledCleanupTick(client),
    intervalMs,
    failureLabel: '[list-notify cleanup] unexpected scheduler failure:',
    logger,
    setIntervalFn,
  });
}

const productionCleanupService = createListNotifyCleanupService();
const productionCleanupScheduler = createListNotifyCleanupScheduler({
  cleanupService: productionCleanupService,
});

export function cleanupAndRefreshListNotifyChannel(channel, options) {
  return productionCleanupService.cleanupAndRefreshListNotifyChannel(channel, options);
}

export function startListNotifyCleanup(client) {
  return productionCleanupScheduler.start(client);
}
