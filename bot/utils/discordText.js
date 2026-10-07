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
