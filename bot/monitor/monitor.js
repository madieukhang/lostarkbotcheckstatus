/**
 * monitor.js
 * Handles the periodic server-status polling loop.
 * Reads/writes monitor state in MongoDB and triggers Discord notifications
 * when the server transitions from offline/maintenance → online, and once
 * when it goes down outside the weekly maintenance schedule.
 */

import config from '../config.js';
import ServerMonitorState from '../models/ServerMonitorState.js';
import { COLORS, relativeTime } from '../utils/ui.js';
import { createArtistEmbed } from '../utils/artistVoice.js';
import GuildConfig from '../models/GuildConfig.js';
import { getGuildLanguage, t } from '../services/i18n/index.js';
import { getMultiServerStatus, STATUS } from './serverStatus.js';
import {
  finishOutageNotification,
  finishRecoveryNotification,
  observeServerStatus,
} from './stateStore.js';

// ─── Notification builder ─────────────────────────────────────────────────────

/**
 * Send one server-watch embed, with an @here ping, to the configured channel.
 * The author, server field and footer are shared with the online notice.
 * @param {import('discord.js').Client} client
 * @param {object} notice
 * @param {string} notice.serverName
 * @param {string} notice.glyph - status glyph that leads the title
 * @param {number} notice.color
 * @param {string} notice.textKey - dialogue key holding `title` and `description`
 * @param {string} notice.timeFieldKey - dialogue key of the time field label
 * @param {string} notice.sentLog - console line written once Discord accepts it
 * @returns {Promise<boolean>} true when Discord accepted the message
 */
async function sendServerNotice(client, { serverName, glyph, color, textKey, timeFieldKey, sentLog }) {
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
        name: `🕐 ${t(timeFieldKey, lang)}`,
        value: relativeTime(Date.now()),
        inline: true,
      },
    ];
    const embed = createArtistEmbed()
      .setAuthor({ name: t('dialogue.system.onlineNotice.author', lang) })
      .setTitle(`${glyph} ${t(`${textKey}.title`, lang, { server: serverName })}`)
      .setDescription(t(`${textKey}.description`, lang, { server: serverName }))
      .addFields(fields)
      .setColor(color)
      .setFooter({ text: t('dialogue.system.onlineNotice.footer', lang) })
      .setTimestamp();

    await channel.send({ content: '@here', embeds: [embed] });
    console.log(`[monitor] ${sentLog}`);
    return true;
  } catch (err) {
    console.error('[monitor] Failed to send notification:', err.message);
    return false;
  }
}

function sendOnlineNotification(client, serverName) {
  return sendServerNotice(client, {
    serverName,
    glyph: '🟢',
    color: COLORS.success,
    textKey: 'dialogue.system.onlineNotice',
    timeFieldKey: 'dialogue.system.onlineNotice.onlineAtField',
    sentLog: `Online notification sent for ${serverName}.`,
  });
}

// The wrench is announced maintenance; a server down without it may have
// crashed, so the two outages read differently. Glyphs match /la-status.
const OUTAGE_NOTICE_STYLE = Object.freeze({
  [STATUS.MAINTENANCE]: { key: 'maintenance', glyph: '🟡', color: COLORS.warning },
  [STATUS.OFFLINE]: { key: 'offline', glyph: '🔴', color: COLORS.danger },
});

function sendOutageNotification(client, serverName, status) {
  const style = OUTAGE_NOTICE_STYLE[status];
  return sendServerNotice(client, {
    serverName,
    glyph: style.glyph,
    color: style.color,
    textKey: `dialogue.system.outageNotice.${style.key}`,
    timeFieldKey: 'dialogue.system.outageNotice.sinceField',
    sentLog: `Outage notification sent for ${serverName} (${status}).`,
  });
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

/**
 * True from an hour before the weekly maintenance window until it ends. A
 * downtime first seen here is the scheduled one, possibly starting early, so
 * it gets the recovery alert only and no outage alert.
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isInScheduledDowntime(now = new Date()) {
  return isInMaintenanceWindow(now) || (now.getUTCDay() === 3 && now.getUTCHours() === 6);
}

// Outside the weekly window a light check still catches an unscheduled downtime.
const IDLE_CHECK_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Whether a scheduler tick checks now: every tick inside the weekly window or
 * while a recovery is pending, and every IDLE_CHECK_INTERVAL_MS otherwise.
 * @param {Date} [now]
 * @param {boolean} [recoveryPending=false]
 * @param {number} [lastRunAt] - start of the last check in ms; defaults to now
 * @returns {boolean}
 */
export function shouldRunScheduledCheck(now = new Date(), recoveryPending = false, lastRunAt = now.getTime()) {
  return isInMaintenanceWindow(now)
    || recoveryPending
    || now.getTime() - lastRunAt >= IDLE_CHECK_INTERVAL_MS;
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
 * @param {{undelivered?: Set<string>}} [options] - undelivered collects the
 *   servers that are online while their recovery alert is still owed under
 *   another worker's claim; the status map keeps showing them online.
 * @returns {Promise<Map<string, string>>} Map of server name → STATUS
 */
export async function checkStatus(client, { undelivered = new Set() } = {}) {
  const servers = config.targetServers;
  let statusMap;

  try {
    statusMap = await getMultiServerStatus(servers);
  } catch (err) {
    console.error('[monitor] Error fetching server status:', err.message);
    throw err;
  }

  const announceOutage = !isInScheduledDowntime(new Date());
  for (const [server, currentStatus] of statusMap) {
    const transition = await observeServerStatus({ server, status: currentStatus, announceOutage });
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
    } else if (transition.deliveryPending) {
      undelivered.add(server);
    }

    if (transition.shouldNotifyOutage) {
      console.log(`[monitor] ${server} is ${currentStatus} outside the schedule - sending outage notification.`);
      const sent = await sendOutageNotification(client, server, currentStatus);
      await finishOutageNotification({ server, claimId: transition.outageClaimId, sent });
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
  let lastRunAt = Date.now();

  const runCheck = async (label) => {
    if (checkInFlight) return;

    checkInFlight = true;
    lastRunAt = Date.now();
    try {
      const undelivered = new Set();
      const statusMap = await checkStatus(client, { undelivered });
      recoveryPending = needsRecoveryPolling(statusMap) || undelivered.size > 0;
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

  return setInterval(() => {
    if (!shouldRunScheduledCheck(new Date(), recoveryPending, lastRunAt)) {
      return;
    }

    void runCheck('Scheduled');
  }, config.checkIntervalMs);
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
