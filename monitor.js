/**
 * monitor.js
 * Handles the periodic server-status polling loop.
 * Reads/writes state to a local JSON file and triggers Discord notifications
 * when the server transitions from offline/maintenance → online.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';
import config from './config.js';
import { getServerStatus, STATUS } from './serverStatus.js';

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
 * Persist the state object to disk atomically (write-then-rename isn't
 * available cross-platform in pure Node, so we just overwrite).
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
async function sendOnlineNotification(client) {
  try {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || !channel.isTextBased()) {
      console.error('[monitor] Notification channel not found or is not a text channel.');
      return;
    }

    // Role mention string (<@&ROLE_ID>)
    // const roleMention = `<@&${config.roleId}>`;

    // Embed matching the spec: title "Thông báo", Vietnamese celebration message
    const embed = new EmbedBuilder()
      .setTitle('Thông báo')
      .setDescription('Server status is online 🎉')
      .setColor(15258703) // Decimal colour value from spec (#E9B84F amber-gold)
      .setTimestamp();

    // await channel.send({ content: roleMention, embeds: [embed] });
    await channel.send({ content: '@here', embeds: [embed] });

    console.log('[monitor] Online notification sent.');
  } catch (err) {
    console.error('[monitor] Failed to send notification:', err.message);
  }
}

// ─── Maintenance window helper ───────────────────────────────────────────────

/**
 * Returns true if current UTC time is inside the weekly Lost Ark maintenance window.
 * Maintenance always falls on Wednesday UTC (converted from Vietnam UTC+7):
 *   - DST off (is_dst=false): Wednesday 08:00 → 20:00 UTC
 *   - DST on  (is_dst=true):  Wednesday 07:00 → 19:00 UTC
 */
function isInMaintenanceWindow() {
  const now = new Date();

  // Detect US DST: July offset < January offset means DST is active
  const janOffset = new Date(now.getUTCFullYear(), 0, 1).getTimezoneOffset();
  const julOffset = new Date(now.getUTCFullYear(), 6, 1).getTimezoneOffset();
  const isDst = julOffset < janOffset;

  const day  = now.getUTCDay();   // 3 = Wednesday
  const hour = now.getUTCHours();

  if (day !== 3) return false;  // Only Wednesday UTC

  const startHour = isDst ? 7 : 8;
  const endHour   = isDst ? 19 : 20;

  return hour >= startHour && hour < endHour;
}

// ─── Core check logic ─────────────────────────────────────────────────────────

/**
 * Perform a single status check:
 *   1. Fetch current status from the website
 *   2. Compare with stored previous status
 *   3. Send notification if the server just came online
 *   4. Save updated state
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<string>} The current STATUS value
 */
export async function checkStatus(client, { force = false } = {}) {
  if (!force && isInMaintenanceWindow()) {
    console.log('[monitor] 🛠️  Skipping check – inside weekly maintenance window.');
    const state = await loadState();
    return state.lastStatus;
  }

  const state = await loadState();
  let currentStatus;

  try {
    currentStatus = await getServerStatus();
    console.log(`[monitor] Status fetched: ${currentStatus} (was: ${state.lastStatus ?? 'unknown'})`);
  } catch (err) {
    console.error('[monitor] Error fetching server status:', err.message);
    // Update check time even on failure so we don't spam error logs with stale timestamps
    state.lastCheckTime = new Date().toISOString();
    await saveState(state);
    throw err; // Re-throw so callers (/check command) can report the error
  }

  const previousStatus = state.lastStatus;
  const now = new Date().toISOString();

  // Record the very first status observed
  if (state.initialStatus === null) {
    state.initialStatus = currentStatus;
  }

  // ── Transition detection ──────────────────────────────────────────────────
  // Only alert when transitioning FROM offline or maintenance TO online.
  // This prevents duplicate alerts if the bot restarts while online.
  const wasDown =
    previousStatus === STATUS.OFFLINE || previousStatus === STATUS.MAINTENANCE;
  const isNowOnline = currentStatus === STATUS.ONLINE;

  if (wasDown && isNowOnline) {
    console.log('[monitor] Transition detected: server came online – sending notification.');
    await sendOnlineNotification(client);
    state.lastAlertTime = now;
  }

  // Persist updated state
  state.lastStatus = currentStatus;
  state.lastCheckTime = now;
  await saveState(state);

  return currentStatus;
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

  // Run immediately on startup, then on each interval tick
  checkStatus(client).catch((err) =>
    console.error('[monitor] Initial check failed:', err.message)
  );

  const handle = setInterval(() => {
    checkStatus(client).catch((err) =>
      console.error('[monitor] Scheduled check failed:', err.message)
    );
  }, config.checkIntervalMs);

  return handle;
}

// ─── State management helpers (used by slash commands) ───────────────────────

/**
 * Return a snapshot of the current persisted state (read-only).
 * @returns {Promise<object>}
 */
export async function getState() {
  return loadState();
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
