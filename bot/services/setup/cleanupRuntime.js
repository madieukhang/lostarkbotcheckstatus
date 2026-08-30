import { formatCleanupFailureReasons } from './channelCleanup.js';

export async function resolveGuildTextChannel(client, { channelId, guildId }) {
  if (!channelId || !guildId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    const channelGuildId = channel?.guildId || channel?.guild?.id;
    if (!channel || channelGuildId !== guildId) return null;
    if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;
    return channel.messages?.fetch ? channel : null;
  } catch {
    return null;
  }
}

export async function prepareCleanupChannel({
  client,
  config,
  channelId,
  resolveChannel,
  checkPermissions,
  permissionOptions,
  logPrefix,
  logger = console,
}) {
  const channel = await resolveChannel(client, config);
  if (!channel) {
    logger.warn?.(
      logPrefix + ' channel unavailable guild=' + config.guildId +
      ' channel=' + channelId
    );
    return null;
  }

  const guild = channel.guild || client.guilds?.cache?.get?.(config.guildId);
  const permissionCheck = checkPermissions(channel, guild, permissionOptions);
  if (!permissionCheck.ok) {
    logger.warn?.(
      logPrefix + ' permissions missing guild=' + config.guildId +
      ' channel=' + channelId +
      ' missing=' + permissionCheck.missing.join(', ')
    );
    return null;
  }

  return channel;
}

export function createIncompleteCleanupError(outcome, { code = '' } = {}) {
  const deleted = Number(outcome?.deleted) || 0;
  const failed = Number(outcome?.failed) || 0;
  const truncated = Boolean(outcome?.truncated);
  const failureSummary = formatCleanupFailureReasons(outcome?.failureReasons);
  const error = new Error(
    'incomplete cleanup deleted=' + deleted +
    ' failed=' + failed +
    ' truncated=' + truncated +
    (failureSummary ? ' errors=' + failureSummary : '')
  );
  if (code) error.code = code;
  error.cleanup = outcome;
  return error;
}

export function createCleanupScheduler({
  runCleanup,
  intervalMs,
  failureLabel,
  logger = console,
  setIntervalFn = setInterval,
}) {
  let timer = null;
  let running = false;

  async function run(client) {
    if (running) return;
    running = true;
    try {
      await runCleanup(client);
    } catch (err) {
      logger.error?.(failureLabel, err?.message || err);
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
