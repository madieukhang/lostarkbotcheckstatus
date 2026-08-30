import GuildConfig from '../../models/GuildConfig.js';
import { getGuildLanguage } from '../i18n/index.js';
import {
  cleanupChannelMessages,
  formatCleanupFailureReasons,
} from './channelCleanup.js';
import { checkBotPermissions } from './channelPermissions.js';
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
  try {
    const channel = await client.channels.fetch(config.listNotifyChannelId);
    const channelGuildId = channel?.guildId || channel?.guild?.id;
    if (!channel || channelGuildId !== config.guildId) return null;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;
    return channel.messages?.fetch ? channel : null;
  } catch {
    return null;
  }
}

function incompleteCleanupError(outcome) {
  const failureSummary = formatCleanupFailureReasons(outcome?.failureReasons);
  const err = new Error(
    'incomplete cleanup deleted=' + (Number(outcome?.deleted) || 0) +
    ' failed=' + (Number(outcome?.failed) || 0) +
    ' truncated=' + Boolean(outcome?.truncated) +
    (failureSummary ? ' errors=' + failureSummary : '')
  );
  err.code = 'LIST_NOTIFY_CLEANUP_INCOMPLETE';
  err.cleanup = outcome;
  return err;
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
      const channel = await resolveChannel(client, config);
      if (!channel) {
        logger.warn?.(
          '[list-notify cleanup] channel unavailable guild=' + config.guildId +
          ' channel=' + config.listNotifyChannelId
        );
        continue;
      }

      const permissionCheck = checkPermissions(
        channel,
        channel.guild || client.guilds?.cache?.get?.(config.guildId),
        { cleanup: true, welcomePin: true }
      );
      if (!permissionCheck.ok) {
        logger.warn?.(
          '[list-notify cleanup] permissions missing guild=' + config.guildId +
          ' channel=' + config.listNotifyChannelId +
          ' missing=' + permissionCheck.missing.join(', ')
        );
        continue;
      }

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
  let timer = null;
  let running = false;

  async function run(client) {
    if (running) return;
    running = true;
    try {
      await cleanupService.runScheduledCleanupTick(client);
    } catch (err) {
      logger.error?.(
        '[list-notify cleanup] unexpected scheduler failure:',
        err?.message || err
      );
    } finally {
      running = false;
    }
  }

  function start(client) {
    if (timer) return timer;
    void run(client);
    timer = setIntervalFn(() => run(client), intervalMs);
    timer.unref?.();
    return timer;
  }

  return { start };
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
