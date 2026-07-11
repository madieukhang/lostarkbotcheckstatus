import GuildConfig from '../../models/GuildConfig.js';
import { autoCheckChannelGuard } from './autoCheckChannelGuard.js';
import { checkBotPermissions } from './channelPermissions.js';
import {
  buildAutoCheckCleanupEligibility,
  resolveAutoCheckCleanupEnabled,
} from './autoCheckCleanupPolicy.js';

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

function cleanupFailureKey(err) {
  const code = err?.code ?? err?.rawError?.code ?? 'unknown';
  const message = String(
    err?.message || err?.rawError?.message || err?.name || 'Unknown error'
  )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return String(code) + ':' + message;
}

export function formatCleanupFailureReasons(failureReasons = {}) {
  return Object.entries(failureReasons)
    .map(([reason, count]) => reason + ' x' + count)
    .join(', ');
}

export async function cleanupAutoCheckChannelMessages(
  channel,
  { maxPages = 20, protectedMessageIds = [] } = {}
) {
  const protectedIds = new Set(
    [...protectedMessageIds].filter(Boolean).map(String)
  );
  let before;
  let deleted = 0;
  let failed = 0;
  let scanned = 0;
  let truncated = false;
  const failureReasons = {};

  for (let page = 0; page < maxPages; page += 1) {
    const fetchOptions = { limit: 100 };
    if (before) fetchOptions.before = before;
    const fetched = await channel.messages.fetch(fetchOptions);
    if (!fetched || fetched.size === 0) break;

    scanned += fetched.size;
    before = fetched.last?.()?.id;
    for (const message of fetched.values()) {
      if (message.pinned || protectedIds.has(String(message.id))) continue;
      try {
        await message.delete();
        deleted += 1;
      } catch (err) {
        failed += 1;
        const reason = cleanupFailureKey(err);
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      }
    }

    if (fetched.size < 100) break;
    if (!before) {
      truncated = true;
      break;
    }
    if (page === maxPages - 1) truncated = true;
  }

  return { deleted, failed, scanned, truncated, failureReasons };
}

async function resolveConfiguredChannel(client, config) {
  try {
    const channel = await client.channels.fetch(config.autoCheckChannelId);
    if (!channel || channel.guildId !== config.guildId) return null;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;
    return channel.messages?.fetch ? channel : null;
  } catch {
    return null;
  }
}

export function createAutoCheckCleanupService({
  GuildConfigModel = GuildConfig,
  cleanupMessages = cleanupAutoCheckChannelMessages,
  nowDate = () => new Date(),
  resolveChannel = resolveConfiguredChannel,
  channelGuard = autoCheckChannelGuard,
  checkPermissions = checkBotPermissions,
  ownerGuildId = (process.env.OWNER_GUILD_ID || '').trim(),
  logger = console,
} = {}) {
  const cleanupEligibility = buildAutoCheckCleanupEligibility(ownerGuildId);

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
      if (!resolveAutoCheckCleanupEnabled(config, config.guildId, ownerGuildId)) {
        continue;
      }

      const channel = await resolveChannel(client, config);
      if (!channel) {
        logger.warn?.('[auto-check cleanup] channel unavailable guild=' + config.guildId + ' channel=' + config.autoCheckChannelId);
        continue;
      }

      const permissionCheck = checkPermissions(
        channel,
        channel.guild || client.guilds?.cache?.get?.(config.guildId),
        { cleanup: true }
      );
      if (!permissionCheck.ok) {
        logger.warn?.(
          '[auto-check cleanup] permissions missing guild=' + config.guildId +
          ' channel=' + config.autoCheckChannelId +
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
              const failureSummary = formatCleanupFailureReasons(outcome.failureReasons);
              throw new Error(
                'incomplete cleanup deleted=' + outcome.deleted +
                ' failed=' + outcome.failed +
                ' truncated=' + Boolean(outcome.truncated) +
                (failureSummary ? ' errors=' + failureSummary : '')
              );
            }
            logger.info?.(
              '[auto-check cleanup] guild=' + config.guildId +
              ' day=' + dayKey +
              ' deleted=' + outcome.deleted
            );
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
  let timer = null;
  let running = false;

  async function run(client) {
    if (running) return;
    running = true;
    try {
      await cleanupService.runDailyCleanupTick(client);
    } catch (err) {
      logger.error?.('[auto-check cleanup] unexpected scheduler failure:', err?.message || err);
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

const productionCleanupService = createAutoCheckCleanupService();
const productionCleanupScheduler = createAutoCheckCleanupScheduler({
  cleanupService: productionCleanupService,
});

export function startAutoCheckCleanup(client) {
  return productionCleanupScheduler.start(client);
}
