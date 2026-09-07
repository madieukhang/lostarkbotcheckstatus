/** Trim an inline Discord label and reserve space for its truncation suffix. */
export function truncateInlineText(value, limit, suffix = '...') {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  if (limit <= suffix.length) return text.slice(0, limit);
  return `${text.slice(0, limit - suffix.length)}${suffix}`;
}
