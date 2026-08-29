/**
 * monitor.js
 * Handles the periodic server-status polling loop.
 * Reads/writes state to a local JSON file and triggers Discord notifications
 * when the server transitions from offline/maintenance → online.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import { COLORS } from '../utils/ui.js';
import { createArtistEmbed } from '../utils/artistVoice.js';
import GuildConfig from '../models/GuildConfig.js';
import { getGuildLanguage, t } from '../services/i18n/index.js';
import { getServerStatus, getMultiServerStatus, STATUS } from './serverStatus.js';

// ─── State helpers ────────────────────────────────────────────────────────────

/**
 * Load the persisted state from disk.
 * Returns a default object if the file is missing or corrupt.
 * @returns {Promise<object>}
 */
async function loadState() {
  try {
    const raw = await fs.readFile(config.stateFilePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    // File missing or malformed – start fresh
    return {
      initialStatus: null,
      lastStatus: null,
      lastCheckTime: null,
      lastAlertTime: null,
    };
  }
}

/**
 * Persist the state object to disk. This path overwrites the target directly
 * because cross-platform write-then-rename is not used here.
 * @param {object} state
 */
async function saveState(state) {
  // Ensure the data directory exists before writing
  await fs.mkdir(path.dirname(config.stateFilePath), { recursive: true });
  await fs.writeFile(config.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Notification builder ─────────────────────────────────────────────────────

/**
 * Build and send the Discord "server is online" embed to the configured channel.
 * @param {import('discord.js').Client} client
 */
async function sendOnlineNotification(client, serverName) {
  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !channel.isTextBased()) {
      console.error('[monitor] Notification channel not found or is not a text channel.');
      return;
    }
    const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });

    // The other monitored servers, listed so the embed surfaces "is the
    // rest of the cluster also up?" context without forcing the reader
    // to run /la-status separately. Self-filter so the focal server
    // isn't repeated in the secondary list.
    const otherServers = (config.targetServers || [])
      .filter((s) => s && s.toLowerCase() !== String(serverName).toLowerCase());

    const fields = [
      {
        name: `🌐 ${t('dialogue.system.onlineNotice.serverField', lang)}`,
        value: `**${serverName}**`,
        inline: true,
      },
      {
        name: `🕐 ${t('dialogue.system.onlineNotice.onlineAtField', lang)}`,
        value: `<t:${Math.floor(Date.now() / 1000)}:R>`,
        inline: true,
      },
    ];
    if (otherServers.length > 0) {
      fields.push({
        name: `📡 ${t('dialogue.system.onlineNotice.monitoredField', lang)}`,
        value: otherServers.map((s) => `\`${s}\``).join(' · '),
        inline: false,
      });
    }

    const embed = createArtistEmbed(lang)
      .setAuthor({ name: t('dialogue.system.onlineNotice.author', lang) })
      .setTitle(`🟢 ${t('dialogue.system.onlineNotice.title', lang, { server: serverName })}`)
      .setDescription(t('dialogue.system.onlineNotice.description', lang, { server: serverName }))
      .addFields(fields)
      .setColor(COLORS.success)
      .setFooter({ text: t('dialogue.system.onlineNotice.footer', lang) })
      .setTimestamp();

    await channel.send({ content: '@here', embeds: [embed] });

    console.log(`[monitor] Online notification sent for ${serverName}.`);
  } catch (err) {
    console.error('[monitor] Failed to send notification:', err.message);
  }
}

// ─── Maintenance window helper ───────────────────────────────────────────────

/**
 * Returns true if current UTC time is inside the weekly Lost Ark maintenance window.
 * Maintenance window is fixed to 24 hours:
 *   Wednesday 07:00 UTC → Thursday 07:00 UTC
 */
export function isInMaintenanceWindow(now = new Date()) {
  const day = now.getUTCDay(); // 3 = Wednesday, 4 = Thursday
  const hour = now.getUTCHours();

  if (day === 3 && hour >= 7) return true;
  if (day === 4 && hour < 7) return true;
  return false;
}

/**
 * Keep the last definitive server state when the upstream page is incomplete.
 * UNKNOWN describes the observation, not a real server transition, so storing
 * it would erase the OFFLINE/MAINTENANCE state needed for recovery alerts.
 */
export function resolvePersistedStatus(previousStatus, observedStatus) {
  if (observedStatus == null || observedStatus === STATUS.UNKNOWN) {
    return previousStatus ?? null;
  }
  return observedStatus;
}

/**
 * Apply one observed status to persisted per-server state.
 * Returns whether this observation is a confirmed down-to-online transition.
 */
export function recordServerStatus(state, server, observedStatus) {
  if (!state.servers) state.servers = {};
  if (!state.servers[server]) {
    state.servers[server] = { initialStatus: null, lastStatus: null, lastAlertTime: null };
  }

  const serverState = state.servers[server];

  if (observedStatus === STATUS.UNKNOWN) {
    return { serverState, shouldNotify: false };
  }

  if (serverState.initialStatus === null) {
    serverState.initialStatus = observedStatus;
  }

  const wasDown =
    serverState.lastStatus === STATUS.OFFLINE || serverState.lastStatus === STATUS.MAINTENANCE;
  const shouldNotify = wasDown && observedStatus === STATUS.ONLINE;

  serverState.lastStatus = resolvePersistedStatus(serverState.lastStatus, observedStatus);
  return { serverState, shouldNotify };
}

/**
 * Continue checking beyond the normal maintenance window until every monitored
 * server has a definitive ONLINE result. An empty result is unresolved too.
 */
export function needsRecoveryPolling(statusMap) {
  if (statusMap.size === 0) return true;
  return [...statusMap.values()].some((status) => status !== STATUS.ONLINE);
}

export function shouldRunScheduledCheck(now = new Date(), recoveryPending = false) {
  return isInMaintenanceWindow(now) || recoveryPending;
}

// ─── Core check logic ─────────────────────────────────────────────────────────

/**
 * Perform a status check for all configured servers:
 *   1. Fetch current status from the website (single page fetch)
 *   2. Compare with stored previous status per server
 *   3. Send notification for each server that transitions to online
 *   4. Save updated state
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<Map<string, string>>} Map of server name → STATUS
 */
export async function checkStatus(client) {
  const state = await loadState();
  const servers = config.targetServers;
  let statusMap;

  // Ensure per-server state structure
  if (!state.servers) state.servers = {};

  try {
    statusMap = await getMultiServerStatus(servers);
    for (const [server, status] of statusMap) {
      const prev = state.servers[server]?.lastStatus ?? 'unknown';
      console.log(`[monitor] ${server}: ${status} (was: ${prev})`);
    }
  } catch (err) {
    console.error('[monitor] Error fetching server status:', err.message);
    state.lastCheckTime = new Date().toISOString();
    await saveState(state);
    throw err;
  }

  const now = new Date().toISOString();

  for (const [server, currentStatus] of statusMap) {
    const { serverState, shouldNotify } = recordServerStatus(state, server, currentStatus);

    if (shouldNotify) {
      console.log(`[monitor] ${server} came online – sending notification.`);
      await sendOnlineNotification(client, server);
      serverState.lastAlertTime = now;
    }
  }

  // Backward compat: keep top-level lastStatus for /la-status command
  state.lastStatus = resolvePersistedStatus(state.lastStatus, statusMap.get(servers[0]));
  state.lastCheckTime = now;
  await saveState(state);

  return statusMap;
}

// ─── Polling loop ─────────────────────────────────────────────────────────────

/**
 * Start the monitoring interval.
 * Returns the interval handle so it can be cleared if needed.
 *
 * @param {import('discord.js').Client} client
 * @returns {NodeJS.Timeout}
 */
export function startMonitor(client) {
  console.log(
    `[monitor] Starting monitor. Checking every ${config.checkIntervalMs / 1000}s…`
  );

  let recoveryPending = false;
  let checkInFlight = false;

  const runCheck = async (label) => {
    if (checkInFlight) return;

    checkInFlight = true;
    try {
      const statusMap = await checkStatus(client);
      recoveryPending = needsRecoveryPolling(statusMap);
    } catch (err) {
      // A request failure during maintenance must not let the scheduler stop at
      // the fixed window boundary. Preserve an existing recovery wait as well.
      recoveryPending = recoveryPending || isInMaintenanceWindow();
      console.error(`[monitor] ${label} check failed:`, err.message);
    } finally {
      checkInFlight = false;
    }
  };

  // Run immediately on startup, then on each interval tick
  void runCheck('Initial');

  const handle = setInterval(() => {
    if (!shouldRunScheduledCheck(new Date(), recoveryPending)) {
      return;
    }

    void runCheck('Scheduled');
  }, config.checkIntervalMs);

  return handle;
}

/**
 * Reset the state file back to its default empty values.
 * @returns {Promise<void>}
 */
export async function resetState() {
  const empty = {
    initialStatus: null,
    lastStatus: null,
    lastCheckTime: null,
    lastAlertTime: null,
  };
  await saveState(empty);
  console.log('[monitor] State reset.');
}
