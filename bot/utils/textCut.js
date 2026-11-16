/**
 * utils/textCut.js
 * Cutting text to a length on a whole character. It imports nothing, so a
 * model or a parser can use it without loading discord.js.
 */

const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * Cut text to a length without leaving half of a two-unit character (an
 * emoji) at the end: a lone high surrogate is not well-formed text.
 * @param {unknown} value - the text; null and undefined become ''
 * @param {number} limit - most UTF-16 units to keep
 * @returns {string} at most `limit` units, ending on a whole character
 */
export function cutText(value, limit) {
  const cut = String(value ?? '').slice(0, limit);
  return TRAILING_HIGH_SURROGATE.test(cut) ? cut.slice(0, -1) : cut;
}
