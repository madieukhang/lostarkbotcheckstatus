export const DISCORD_CONTENT_LIMIT = 2000;

export function truncateInlineText(value, limit, suffix = '...') {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  if (limit <= suffix.length) return text.slice(0, limit);
  return `${text.slice(0, limit - suffix.length)}${suffix}`;
}

export function truncateDiscordContent(content, limit = DISCORD_CONTENT_LIMIT) {
  if (typeof content !== 'string' || content.length <= limit) return content;

  const suffix = '\n... truncated';
  if (limit <= suffix.length) return content.slice(0, limit);

  return `${content.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
}
