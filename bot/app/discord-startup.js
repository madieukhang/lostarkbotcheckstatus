import { Events } from 'discord.js';

const DISCORD_LOGIN_TIMEOUT_MS = 60_000;
const DISCORD_RECONNECT_TIMEOUT_MS = 600_000;

class DiscordLoginTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Discord login did not become ready within ${timeoutMs}ms`);
    this.name = 'DiscordLoginTimeoutError';
  }
}

/**
 * Add concise gateway diagnostics without enabling discord.js' very noisy
 * debug stream. These events remain useful after the initial login when a
 * live shard disconnects or starts reconnecting. A shard that neither
 * resumes nor re-identifies within `reconnectTimeoutMs` of starting to
 * reconnect hands shutdown to the supplied terminator (exit code 1), so the
 * host can restart the process.
 * @param {import('discord.js').Client} client
 * @param {{
 *   terminate: (options: { label: string, exitCode: number }) => Promise<boolean>,
 *   reconnectTimeoutMs?: number,
 *   setTimeoutFn?: typeof setTimeout,
 *   clearTimeoutFn?: typeof clearTimeout,
 *   logger?: Console,
 * }} options
 * @returns {void}
 */
export function installDiscordGatewayDiagnostics(client, {
  terminate,
  reconnectTimeoutMs = DISCORD_RECONNECT_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (typeof terminate !== 'function') {
    throw new TypeError('Discord gateway diagnostics require a terminator');
  }
  if (!Number.isFinite(reconnectTimeoutMs) || reconnectTimeoutMs <= 0) {
    throw new RangeError('Discord reconnect timeout must be a positive number');
  }

  const reconnects = new Map();

  function finishReconnect(shardId, outcome) {
    const reconnect = reconnects.get(shardId);
    if (!reconnect) return;

    reconnects.delete(shardId);
    clearTimeoutFn(reconnect.timer);
    const elapsedMs = Math.max(0, Date.now() - reconnect.startedAt);
    logger.log(`[bot] Discord shard ${shardId} ${outcome} in ${elapsedMs}ms.`);
  }

  client.on(Events.ShardError, (error, shardId) => {
    logger.error(`[bot] Discord shard ${shardId} error:`, error);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn(`[bot] Discord shard ${shardId} disconnected (code ${event?.code ?? 'unknown'}).`);
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    const active = reconnects.get(shardId);
    if (active) {
      const elapsedMs = Math.max(0, Date.now() - active.startedAt);
      logger.warn(`[bot] Discord shard ${shardId} still reconnecting after ${elapsedMs}ms...`);
      return;
    }

    const startedAt = Date.now();
    const timer = setTimeoutFn(() => {
      if (reconnects.get(shardId)?.timer !== timer) return;
      reconnects.delete(shardId);
      clearTimeoutFn(timer);
      void terminate({
        label: `Discord shard ${shardId} reconnect timed out after ${Math.ceil(reconnectTimeoutMs / 1000)}s`,
        exitCode: 1,
      });
    }, reconnectTimeoutMs);
    timer?.unref?.();
    reconnects.set(shardId, { startedAt, timer });
    logger.warn(`[bot] Discord shard ${shardId} reconnecting...`);
  });
  client.on(Events.ShardResume, (shardId, replayedEvents) => {
    finishReconnect(shardId, `resumed (replayed ${replayedEvents} events)`);
  });
  client.on(Events.ShardReady, (shardId, unavailableGuilds) => {
    finishReconnect(
      shardId,
      `re-identified (${unavailableGuilds?.size ?? 0} unavailable guilds)`,
    );
  });
}

/**
 * Start Discord login with a hard readiness deadline. discord.js retries
 * gateway Hello/Ready timeouts internally, which can otherwise leave a
 * container alive forever without ever emitting ClientReady.
 * @returns {Promise<boolean>} true when login becomes ready, false after a
 * handled failure/timeout (the supplied terminator owns process shutdown).
 */
export async function startDiscordLogin({
  client,
  token,
  terminate,
  timeoutMs = DISCORD_LOGIN_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Discord login timeout must be a positive number');
  }

  logger.log(`[bot] Connecting to Discord gateway (timeout ${Math.ceil(timeoutMs / 1000)}s)...`);

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeoutFn(() => reject(new DiscordLoginTimeoutError(timeoutMs)), timeoutMs);
    timer?.unref?.();
  });

  try {
    await Promise.race([
      Promise.resolve().then(() => client.login(token)),
      timeout,
    ]);
    return true;
  } catch (error) {
    const timedOut = error instanceof DiscordLoginTimeoutError;
    await terminate({
      label: timedOut
        ? `Discord login timed out after ${Math.ceil(timeoutMs / 1000)}s`
        : 'Discord login failed',
      error: timedOut ? null : error,
      exitCode: 1,
    });
    return false;
  } finally {
    clearTimeoutFn(timer);
  }
}
