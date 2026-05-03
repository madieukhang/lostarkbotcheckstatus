/**
 * alertEmbed.js
 *
 * Shared helper for building consistent "alert" embeds across the bot.
 * Before this existed, warning/error/info messages were a mix of plain-text
 * replies, ad-hoc embeds, and handler-specific helpers — which made the UX
 * inconsistent and made color-coded severity impossible to read at a glance.
 *
 * Tokens live in `bot/utils/ui.js`. This module is the thin builder that
 * pairs a severity with the right color/icon and returns an EmbedBuilder
 * that callers can still chain on.
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
 *     footer: 'Use /la-list view black to see the full entry',
 *   });
 *
 * For domain-specific embeds (list-type cards, preview dialogs) pass
 * `titleIcon` and/or `color` to override the severity defaults while
 * keeping the rest of the layout consistent.
 */

import { EmbedBuilder } from 'discord.js';

import { COLORS, ICONS } from './ui.js';

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

const SEVERITY_CONFIG = Object.freeze({
  error:   { color: COLORS.danger,  icon: ICONS.error  },
  warning: { color: COLORS.warning, icon: ICONS.warn   },
  info:    { color: COLORS.info,    icon: ICONS.info   },
  success: { color: COLORS.success, icon: ICONS.done   },
  trusted: { color: COLORS.trusted, icon: ICONS.shield },
});

/**
 * Build a standardized alert embed.
 *
 * @param {Object} options
 * @param {string} options.severity - One of AlertSeverity.*
 * @param {string} options.title - Short title, shown with severity icon prefix
 * @param {string} [options.description] - Body text, markdown allowed
 * @param {Array<{name: string, value: string, inline?: boolean}>} [options.fields] - Structured data fields
 * @param {string} [options.footer] - Footer hint (e.g. "Use /la-list view ...")
 * @param {boolean} [options.timestamp=true] - Include a timestamp (default true)
 * @param {string} [options.titleIcon] - Override the severity icon prefix on the title.
 *   Use when the embed has a stronger contextual icon (list-type icon,
 *   action icon) than the severity glyph would carry.
 * @param {number} [options.color] - Override the severity color.
 *   Use when the embed sits inside a list-type context (blacklist/whitelist/
 *   watchlist) and the entry color carries more meaning than severity.
 * @returns {EmbedBuilder}
 */
export function buildAlertEmbed({
  severity,
  title,
  description,
  fields = [],
  footer,
  timestamp = true,
  titleIcon,
  color,
}) {
  const config = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
  const finalIcon = titleIcon ?? config.icon;
  const finalColor = color ?? config.color;

  const embed = new EmbedBuilder()
    .setTitle(finalIcon ? `${finalIcon}  ${title}` : title)
    .setColor(finalColor);

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
