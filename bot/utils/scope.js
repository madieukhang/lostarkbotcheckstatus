/**
 * scope.js
 * Shared utilities for blacklist scope filtering and GuildConfig caching.
 */

import config from '../config.js';
import GuildConfig from '../models/GuildConfig.js';

/**
 * Build a MongoDB scope filter for blacklist queries.
 * Owner guild sees all scopes; other guilds see global + own server entries.
 *
 * @param {string} guildId - The requesting guild's ID
 * @param {object} options
 * @param {boolean} options.ownerSeesAll - allow the configured owner guild to
 *   bypass scope visibility filters
 * @param {boolean} options.includeEmptyServerScope - preserve legacy server
 *   entries whose guildId was stored as an empty string
 * @returns {object|null} Scope filter to $and with name query, or null for owner (no filter needed)
 */
function buildBlacklistScopeFilter(
  guildId,
  { ownerSeesAll = true, includeEmptyServerScope = false } = {}
) {
  const isOwnerGuild = ownerSeesAll && guildId && guildId === config.ownerGuildId;
  if (isOwnerGuild) return null; // owner sees everything

  return { $or: [
    { scope: 'global' },
    { scope: { $exists: false } },
    ...(guildId || includeEmptyServerScope
      ? [{ scope: 'server', guildId: guildId || '' }]
      : []),
  ] };
}

/**
 * Build a complete blacklist query by combining name query with scope filter.
 *
 * @param {object} nameQuery - The name/allCharacters match query
 * @param {string} guildId - The requesting guild's ID
 * @param {object} options - forwarded to buildBlacklistScopeFilter
 * @returns {object} MongoDB query
 */
export function buildBlacklistQuery(nameQuery, guildId, options) {
  const scopeFilter = buildBlacklistScopeFilter(guildId, options);
  if (!scopeFilter) return nameQuery; // owner · no scope restriction
  return { $and: [nameQuery, scopeFilter] };
}

/**
 * Apply list-specific visibility rules to a base query. Only blacklist entries
 * have guild scope; whitelist and watchlist queries pass through unchanged.
 *
 * @param {string} type - black | white | watch
 * @param {object} baseQuery - MongoDB query to scope
 * @param {string} guildId - requesting guild ID
 * @param {object} options - forwarded to buildBlacklistQuery
 * @returns {object} scoped query
 */
export function buildScopedListQuery(type, baseQuery, guildId, options) {
  return type === 'black'
    ? buildBlacklistQuery(baseQuery, guildId, options)
    : baseQuery;
}

// ─── GuildConfig cache ─────────────────────────────────────────────────────

const guildConfigCache = new Map();
const GUILD_CONFIG_TTL = 60_000; // 60 seconds

/**
 * Get GuildConfig with in-memory cache (60s TTL).
 * Reduces DB round-trips for frequently accessed guild settings.
 *
 * @param {string} guildId
 * @returns {Promise<object|null>}
 */
export async function getGuildConfig(guildId) {
  if (!guildId) return null;

  const cached = guildConfigCache.get(guildId);
  if (cached && Date.now() - cached.ts < GUILD_CONFIG_TTL) {
    return cached.data;
  }

  const data = await GuildConfig.findOne({ guildId }).lean();
  guildConfigCache.set(guildId, { data, ts: Date.now() });
  return data;
}

/**
 * Invalidate cache for a guild (call after /la-setup changes).
 * @param {string} guildId
 */
export function invalidateGuildConfig(guildId) {
  guildConfigCache.delete(guildId);
}
