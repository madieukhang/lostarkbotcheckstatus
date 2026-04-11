/**
 * alertEmbed.js
 *
 * Shared helper for building consistent "alert" embeds across the bot.
 * Before this existed, warning/error/info messages were a mix of plain-text
 * replies, ad-hoc embeds, and handler-specific helpers — which made the UX
 * inconsistent and made color-coded severity impossible to read at a glance.
 *
 * Usage:
 *   import { buildAlertEmbed, AlertSeverity } from '../utils/alertEmbed.js';
 *
 *   const embed = buildAlertEmbed({
 *     severity: AlertSeverity.WARNING,
 *     title: 'Already in Blacklist',
 *     description: `**${name}** is already blacklisted via roster match.`,
 *     fields: [
 *       { name: 'Matched name', value: 'Gauchaneqa', inline: true },
 *       { name: 'Scope', value: '[Global]', inline: true },
 *     ],
 *     footer: 'Use /list view black to see the full entry',
 *   });
 *
 * Returns an EmbedBuilder so callers can still chain .setImage(), .setThumbnail(),
 * etc. when they need extra customization beyond the standard alert layout.
 */

import { EmbedBuilder } from 'discord.js';

/**
 * Severity levels for alert embeds. Each level maps to a specific color +
 * icon so users can tell severity at a glance without reading the title.
 */
export const AlertSeverity = Object.freeze({
  ERROR: 'error',       // Red    — operation failed, user action required
  WARNING: 'warning',   // Yellow — operation blocked but recoverable
  INFO: 'info',         // Blue   — neutral information, no action required
  SUCCESS: 'success',   // Green  — operation completed successfully
  TRUSTED: 'trusted',   // Navy   — special case for trusted user blocks
});

/**
 * Severity → visual config map. Colors match the existing bot palette
 * (same values used by getListContext for black/white/watch) so the alert
 * embeds feel visually integrated with the rest of the UI.
 */
const SEVERITY_CONFIG = {
  error: {
    color: 0xed4245,   // Discord red — same as blacklist
    icon: '❌',
  },
  warning: {
    color: 0xfee75c,   // Discord yellow — same as watchlist
    icon: '⚠️',
  },
  info: {
    color: 0x5865f2,   // Discord Blurple
    icon: '💡',
  },
  success: {
    color: 0x57f287,   // Discord green — same as whitelist
    icon: '✅',
  },
  trusted: {
    color: 0x3b82f6,   // Tailwind blue-500 — distinct from Blurple
    icon: '🛡️',
  },
};

/**
 * Build a standardized alert embed.
 *
 * @param {Object} options
 * @param {string} options.severity - One of AlertSeverity.*
 * @param {string} options.title - Short title, shown with severity icon prefix
 * @param {string} [options.description] - Body text, markdown allowed
 * @param {Array<{name: string, value: string, inline?: boolean}>} [options.fields] - Structured data fields
 * @param {string} [options.footer] - Footer hint (e.g. "Use /list view ...")
 * @param {boolean} [options.timestamp=true] - Include a timestamp (default true)
 * @returns {EmbedBuilder}
 */
export function buildAlertEmbed({
  severity,
  title,
  description,
  fields = [],
  footer,
  timestamp = true,
}) {
  const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;

  const embed = new EmbedBuilder()
    .setTitle(`${config.icon}  ${title}`)
    .setColor(config.color);

  if (description) {
    embed.setDescription(description);
  }

  if (fields.length > 0) {
    // Filter out fields with empty values — Discord rejects them
    const cleanFields = fields.filter((f) => f.value !== undefined && f.value !== null && String(f.value).trim() !== '');
    if (cleanFields.length > 0) {
      embed.addFields(cleanFields);
    }
  }

  if (footer) {
    embed.setFooter({ text: footer });
  }

  if (timestamp) {
    embed.setTimestamp(new Date());
  }

  return embed;
}
