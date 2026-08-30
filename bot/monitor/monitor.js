/**
 * monitor.js
 * Handles the periodic server-status polling loop.
 * Reads/writes state to a local JSON file and triggers Discord notifications
 * when the server transitions from offline/maintenance → online.
 */

import config from '../config.js';
import ServerMonitorState from '../models/ServerMonitorState.js';
import { COLORS } from '../utils/ui.js';
import { createArtistEmbed } from '../utils/artistVoice.js';
import GuildConfig from '../models/GuildConfig.js';
import { getGuildLanguage, t } from '../services/i18n/index.js';
import { getMultiServerStatus, STATUS } from './serverStatus.js';
import {
  finishRecoveryNotification,
  observeServerStatus,
} from './stateStore.js';

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
      return false;
    }
    const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });

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
    return true;
  } catch (err) {
    console.error('[monitor] Failed to send notification:', err.message);
    return false;
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
  const servers = config.targetServers;
  let statusMap;

  try {
    statusMap = await getMultiServerStatus(servers);
  } catch (err) {
    console.error('[monitor] Error fetching server status:', err.message);
    throw err;
  }

  for (const [server, currentStatus] of statusMap) {
    const transition = await observeServerStatus({ server, status: currentStatus });
    const previousStatus = transition.previousStatus ?? STATUS.UNKNOWN;
    console.log(`[monitor] ${server}: ${currentStatus} (was: ${previousStatus})`);

    if (transition.shouldNotify) {
      console.log(`[monitor] ${server} came online – sending notification.`);
      const sent = await sendOnlineNotification(client, server);
      await finishRecoveryNotification({
        server,
        claimId: transition.claimId,
        sent,
      });
      if (!sent) {
        // Keep the scheduler alive beyond the fixed maintenance window until
        // Discord accepts the recovery alert. The Mongo claim was released
        // above, so the next poll can retry safely.
        statusMap.set(server, STATUS.UNKNOWN);
      }
    }
  }

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
 * Clear the durable Thaemine monitor cursor. The next check establishes a
 * fresh baseline and intentionally does not emit a recovery alert.
 */
export async function resetState() {
  await ServerMonitorState.deleteMany({
    serverName: { $in: config.targetServers },
  });
  console.log('[monitor] Durable server state reset.');
}
