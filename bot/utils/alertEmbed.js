/**
 * alertEmbed.js
 *
 * Shared helper for building consistent "alert" embeds across the bot, so
 * warning, error and info messages read the same everywhere and severity
 * shows as a color at a glance.
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
import { decorateArtistEmbed } from './artistVoice.js';

/**
 * Severity levels for alert embeds. Each level maps to a specific color +
 * icon so users can tell severity at a glance without reading the title.
 */
export const AlertSeverity = Object.freeze({
  ERROR: 'error',       // Red    · operation failed, user action required
  WARNING: 'warning',   // Yellow · operation blocked but recoverable
  INFO: 'info',         // Blue   · neutral information, no action required
  SUCCESS: 'success',   // Green  · operation completed successfully
  TRUSTED: 'trusted',   // Navy   · special case for trusted user blocks
});

const SEVERITY_CONFIG = Object.freeze({
  error:   { color: COLORS.danger,  icon: ICONS.error  },
  warning: { color: COLORS.warning, icon: ICONS.warn   },
  info:    { color: COLORS.info,    icon: ICONS.info   },
  success: { color: COLORS.success, icon: ICONS.done   },
  trusted: { color: COLORS.trusted, icon: ICONS.shield },
});

/**
 * Kinds of simple notice. Each kind has one icon and one colour, so the same
 * situation reads the same everywhere; red is kept for real failures.
 * Rich cards keep `severity` with their own icon and colour.
 */
export const NoticeKind = Object.freeze({
  GUARD: 'guard',         // blocked by permission, wrong user or wrong place
  EXPIRED: 'expired',     // session, preview, picker or entry no longer there
  INPUT: 'input',         // input to fix, or a prerequisite missing
  EMPTY: 'empty',         // a normal empty result
  BUSY: 'busy',           // an outside service or a limit
  FAILURE: 'failure',     // something actually broke
  PROGRESS: 'progress',   // work in flight
  DONE: 'done',           // saved, changed, cancelled on request
  PARTIAL: 'partial',     // done in part; a field names what is missing
});

const KIND_CONFIG = Object.freeze({
  guard:    { color: COLORS.warning, icon: '🔒' },
  expired:  { color: COLORS.muted,   icon: '⌛' },
  input:    { color: COLORS.warning, icon: '✏️' },
  empty:    { color: COLORS.info,    icon: '🔍' },
  busy:     { color: COLORS.warning, icon: '🚦' },
  failure:  { color: COLORS.danger,  icon: ICONS.error },
  progress: { color: COLORS.info,    icon: '⏳' },
  done:     { color: COLORS.success, icon: ICONS.done },
  partial:  { color: COLORS.warning, icon: ICONS.warn },
});

const TIP_ICON = '💡';

// Discord's embed text limits. EmbedBuilder throws past them, and error cards
// carry raw error text, so an over-long error would break the card that
// reports it and leave the previous card (a progress card) on screen.
const EMBED_LIMITS = Object.freeze({ title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048 });

// Cut text to a limit with an ellipsis, closing an inline code span the cut
// would leave open. Non-text values pass through, so the builder still
// rejects a caller's wrong type.
function fitEmbedText(value, limit) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  const codeSpan = value.startsWith('`') && value.endsWith('`') ? '`' : '';
  let end = limit - 1 - codeSpan.length;
  // Never end on the first half of a two-unit character such as an emoji.
  if (/[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
  return `${value.slice(0, end)}…${codeSpan}`;
}

/**
 * Build a standardized alert embed. Text past Discord's per-element limits
 * (title, description, field name and value, footer) is cut to them.
 *
 * @param {Object} options
 * @param {string} [options.kind] - One of NoticeKind.*; sets the icon and
 *   colour of a simple notice and takes precedence over `severity`
 * @param {string} [options.severity] - One of AlertSeverity.*, for rich cards
 * @param {string} [options.tip] - Next step for a simple notice, shown as the
 *   footer behind 💡 with markdown removed (Discord renders none there).
 *   Never combined with `footer`.
 * @param {string} [options.title] - Short title, shown with severity icon prefix
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
 * @param {string} [options.author] - Small line above the title. Use it for
 *   the context a result came out of (which scan, which guild) so the title
 *   is free to carry the result itself. Discord renders no markdown here,
 *   so pass plain text · code marks would show as literal backticks.
 * @returns {EmbedBuilder}
 */
export function buildAlertEmbed({
  kind,
  severity,
  title,
  description,
  fields = [],
  footer,
  tip,
  timestamp = true,
  titleIcon,
  color,
  author,
}) {
  if (tip && footer) throw new Error('[alertEmbed] a notice takes a tip or a footer, not both');
  const config = KIND_CONFIG[kind] || SEVERITY_CONFIG[severity] || SEVERITY_CONFIG.info;
  if (tip) footer = `${TIP_ICON} ${stripInlineMarkdown(tip)}`;
  const finalIcon = titleIcon ?? config.icon;
  const finalColor = color ?? config.color;

  const embed = new EmbedBuilder().setColor(finalColor);
  // Filter out fields with empty values · Discord rejects them.
  const cleanFields = fields.filter(
    (field) => field.value !== undefined
      && field.value !== null
      && String(field.value).trim() !== ''
  ).map((field) => ({
    ...field,
    name: fitEmbedText(field.name, EMBED_LIMITS.fieldName),
    value: fitEmbedText(field.value, EMBED_LIMITS.fieldValue),
  }));
  const mutations = [
    { enabled: Boolean(author), apply: () => embed.setAuthor({ name: String(author).slice(0, 256) }) },
    {
      enabled: Boolean(title),
      apply: () => embed.setTitle(fitEmbedText(finalIcon ? `${finalIcon}  ${title}` : title, EMBED_LIMITS.title)),
    },
    { enabled: Boolean(description), apply: () => embed.setDescription(fitEmbedText(description, EMBED_LIMITS.description)) },
    { enabled: cleanFields.length > 0, apply: () => embed.addFields(cleanFields) },
    { enabled: Boolean(footer), apply: () => embed.setFooter({ text: fitEmbedText(footer, EMBED_LIMITS.footer) }) },
    { enabled: timestamp, apply: () => embed.setTimestamp(new Date()) },
  ];
  mutations.filter(({ enabled }) => enabled).forEach(({ apply }) => apply());

  return decorateArtistEmbed(embed);
}

const LEADING_NOTICE_ICON = /^(?:✅|⚠️|❌|ℹ️|🛡️|⏳|🔍|🔔|🔕|🌐|🔒|🛑|✖️)\s*/u;
// A title shows <#id>, <@id> and <t:unix> as raw text, so a first line
// that names a channel, member, role or time is never promoted to one.
const DISCORD_MENTION = /<(?:#|@[!&]?|t:)\d+/u;

/**
 * Discord renders no markdown in an embed title, so bold and code marks
 * promoted from a notice line arrive as literal `**` and backticks. The
 * emphasis is dropped rather than the text: "Read **1** name" would
 * otherwise reach the user with the asterisks showing.
 *
 * @param {string} value
 * @returns {string}
 */
function stripInlineMarkdown(value) {
  return String(value ?? '')
    .replace(/\*\*(.+?)\*\*/gsu, '$1')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gsu, '$1')
    .replace(/__(.+?)__/gsu, '$1')
    .replace(/`([^`]+)`/gu, '$1');
}

/**
 * Turn a localized text notice into the same compact embed shape used by
 * RaidManage. The first short line becomes the title; any remaining lines
 * become the description. This keeps simple command results readable without
 * forcing every handler to invent a one-off title/description pair.
 */
export function buildNoticeEmbed(content, {
  severity = AlertSeverity.INFO,
  title,
  titleIcon,
  color,
  footer,
  timestamp = false,
} = {}) {
  const text = String(content ?? '').trim();
  const lines = text.split(/\r?\n/);
  const firstLine = (lines[0] || '').replace(LEADING_NOTICE_ICON, '').trim();
  const canPromoteFirstLine = !title
    && firstLine.length > 0
    && firstLine.length <= 256
    && !DISCORD_MENTION.test(firstLine);
  const resolvedTitle = title || (canPromoteFirstLine ? stripInlineMarkdown(firstLine) : undefined);
  const description = canPromoteFirstLine
    ? lines.slice(1).join('\n').trim()
    : text;

  return buildAlertEmbed({
    severity,
    title: resolvedTitle,
    description: description || undefined,
    titleIcon,
    color,
    footer,
    timestamp,
  });
}
