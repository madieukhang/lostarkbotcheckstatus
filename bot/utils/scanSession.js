/**
 * scanSession.js
 *
 * Tiny in-memory registry for currently-running stronghold deep
 * scans. Used so a Stop button click can find the right cancellation
 * flag and flip it without the button handler having to know which
 * Discord interaction owns the scan.
 *
 * Each entry holds a `cancelFlag` ({ cancelled: false }) that the
 * detector's scanWorker checks before each candidate. Setting
 * `.cancelled = true` mid-scan causes the worker to exit early and
 * return the partial result.
 *
 * State is process-local; on bot restart all in-flight scans are
 * abandoned (their interactions would have timed out anyway because
 * Discord webhook reply windows are 15 min and the bot restart drops
 * the interaction tokens).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

const activeScans = new Map(); // sessionId -> { cancelFlag, callerId, startedAt, label }

export function registerScan(sessionId, info) {
  activeScans.set(sessionId, info);
  return info;
}

export function getScan(sessionId) {
  return activeScans.get(sessionId);
}

export function unregisterScan(sessionId) {
  activeScans.delete(sessionId);
}

export function newScanSessionId() {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Build the standard Stop-scan button row attached to scan progress
 * embeds. customId shape: `scan-cancel:<sessionId>`. The dispatch in
 * bot.js routes that prefix family.
 *
 * @param {string} sessionId
 * @param {Object} [opts]
 * @param {boolean} [opts.disabled=false] - Render the button greyed
 *   out (e.g. after the user already clicked Stop, while waiting for
 *   the worker to drop out of its current candidate).
 * @param {string} [opts.label='Stop scan']
 * @returns {ActionRowBuilder}
 */
export function buildStopButtonRow(sessionId, opts = {}) {
  const { disabled = false, label = 'Stop scan' } = opts;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`scan-cancel:${sessionId}`)
      .setLabel(label)
      .setEmoji('🛑')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled)
  );
}
