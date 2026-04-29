export const DISCORD_CONTENT_LIMIT = 2000;

export function truncateDiscordContent(content, limit = DISCORD_CONTENT_LIMIT) {
  if (typeof content !== 'string' || content.length <= limit) return content;

  const suffix = '\n... truncated';
  if (limit <= suffix.length) return content.slice(0, limit);

  return `${content.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
}
