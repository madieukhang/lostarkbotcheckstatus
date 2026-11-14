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

/**
 * Text for a Discord code span: a backtick would end the span early and let
 * the rest render as markdown, so it becomes an apostrophe.
 * @param {string} value
 * @returns {string}
 */
export function codeSpanText(value) {
  return String(value ?? '').replace(/`/g, "'");
}

const LOGS_URL_MAX_LENGTH = 512;

/**
 * Whether a stored logs link can sit in `[label](url)` as typed: an https URL
 * with no whitespace, parenthesis or angle bracket that would end the link
 * early, and at most 512 characters.
 * @param {string} value
 * @returns {boolean}
 */
export function isSafeLogsUrl(value) {
  const text = String(value ?? '');
  if (text.length > LOGS_URL_MAX_LENGTH || /[\s()<>]/.test(text)) return false;
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Trim an inline Discord label and reserve space for its truncation suffix. */
export function truncateInlineText(value, limit, suffix = '...') {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  if (limit <= suffix.length) return text.slice(0, limit);
  return `${text.slice(0, limit - suffix.length)}${suffix}`;
}

/**
 * Text a member stored (a reason, a note), ready for any markdown spot: link
 * brackets are escaped first and the result is then cut, so the escapes count
 * toward the limit and a cut can never leave a bracket unescaped.
 * @param {string} value - the stored text
 * @param {number} [limit=Infinity] - longest result, suffix included
 * @returns {string} the escaped, trimmed text; '' for none
 */
export function storedText(value, limit = Infinity) {
  return truncateInlineText(escapeLinkBrackets(String(value ?? '').trim()), limit);
}
