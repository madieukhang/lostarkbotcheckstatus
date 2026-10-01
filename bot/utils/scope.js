/**
 * scope.js
 * Shared utilities for blacklist scope filtering and GuildConfig caching.
 */

import config from '../config.js';
import GuildConfig from '../models/GuildConfig.js';
import { createLruTtlCache } from './cache/lruTtlCache.js';

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

const GUILD_CONFIG_TTL = 60_000; // 60 seconds
const GUILD_CONFIG_MAX_SIZE = 256;
const guildConfigCache = createLruTtlCache({ ttlMs: GUILD_CONFIG_TTL, maxSize: GUILD_CONFIG_MAX_SIZE });
const guildConfigLoads = new Map();

/**
 * Share overlapping GuildConfig reads and cache results for 60 seconds.
 * Invalidated reads reload before returning so setup changes take precedence.
 *
 * @param {string} guildId
 * @returns {Promise<object|null>}
 */
export async function getGuildConfig(guildId) {
  if (!guildId) return null;

  const cached = guildConfigCache.get(guildId);
  if (cached !== undefined) return cached;
  const inFlight = guildConfigLoads.get(guildId);
  if (inFlight) return inFlight.promise;

  const request = { promise: null };
  request.promise = Promise.resolve()
    .then(() => GuildConfig.findOne({ guildId }).lean())
    .then((data) => {
      if (guildConfigLoads.get(guildId) !== request) return getGuildConfig(guildId);
      guildConfigCache.set(guildId, data);
      return data;
    })
    .finally(() => {
      if (guildConfigLoads.get(guildId) === request) guildConfigLoads.delete(guildId);
    });
  guildConfigLoads.set(guildId, request);
  return request.promise;
}

/**
 * Invalidate cache for a guild (call after /la-setup changes).
 * @param {string} guildId
 * @returns {void}
 */
export function invalidateGuildConfig(guildId) {
  guildConfigCache.delete(guildId);
  guildConfigLoads.delete(guildId);
}
