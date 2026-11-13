import { escapeMarkdown } from 'discord.js';

const CHOICE_TEXT_MAX = 100;
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * Cut an autocomplete choice name or value to Discord's 100-character limit
 * without leaving half of an emoji (a lone high surrogate) at the end.
 * @param {string} value - choice text
 * @returns {string} at most 100 UTF-16 units, ending on a whole character
 */
export function cutChoiceText(value) {
  const cut = String(value).slice(0, CHOICE_TEXT_MAX);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Escape a name someone else chose (a server name, say) before it goes into
 * embed text: Discord's markdown marks, plus the brackets of a masked link,
 * which escapeMarkdown leaves alone.
 * @param {string} value - raw name
 * @returns {string} text that renders as typed
 */
export function escapeEmbedText(value) {
  return escapeMarkdown(String(value)).replace(/[[\]]/g, '\\$&');
}

/**
 * Escape the characters that open or close a Discord masked link, so a
 * stored name placed in `[label](url)` cannot end the label early and add
 * a link of its own.
 * @param {string} value
 * @returns {string}
 */
export function escapeLinkBrackets(value) {
  return String(value).replace(/[\\[\]]/g, '\\$&');
}

/** Trim an inline Discord label and reserve space for its truncation suffix. */
export function truncateInlineText(value, limit, suffix = '...') {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  if (limit <= suffix.length) return text.slice(0, limit);
  return `${text.slice(0, limit - suffix.length)}${suffix}`;
}
