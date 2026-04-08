/**
 * scope.js
 * Shared utilities for blacklist scope filtering and GuildConfig caching.
 */

import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';

/**
 * Build a MongoDB scope filter for blacklist queries.
 * Owner guild sees all scopes; other guilds see global + own server entries.
 *
 * @param {string} guildId - The requesting guild's ID
 * @returns {object|null} Scope filter to $and with name query, or null for owner (no filter needed)
 */
export function buildBlacklistScopeFilter(guildId) {
  const isOwnerGuild = guildId && guildId === config.ownerGuildId;
  if (isOwnerGuild) return null; // owner sees everything

  return { $or: [
    { scope: 'global' },
    { scope: { $exists: false } },
    ...(guildId ? [{ scope: 'server', guildId }] : []),
  ] };
}

/**
 * Build a complete blacklist query by combining name query with scope filter.
 *
 * @param {object} nameQuery - The name/allCharacters match query
 * @param {string} guildId - The requesting guild's ID
 * @returns {object} MongoDB query
 */
export function buildBlacklistQuery(nameQuery, guildId) {
  const scopeFilter = buildBlacklistScopeFilter(guildId);
  if (!scopeFilter) return nameQuery; // owner — no scope restriction
  return { $and: [nameQuery, scopeFilter] };
}

/**
 * Check if a guild is the owner guild.
 * @param {string} guildId
 * @returns {boolean}
 */
export function isOwnerGuild(guildId) {
  return Boolean(guildId && guildId === config.ownerGuildId);
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
 * Invalidate cache for a guild (call after /lasetup changes).
 * @param {string} guildId
 */
export function invalidateGuildConfig(guildId) {
  guildConfigCache.delete(guildId);
}
