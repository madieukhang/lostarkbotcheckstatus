/**
 * services/roster/listChecks.js
 * Roster-vs-list lookup helpers backing /la-check + auto-check.
 * Blacklist + whitelist queries are case-insensitive (collation
 * strength 2) so OCR-folded names land on the right row. Returns the
 * full entry shape via shapeRosterListHit so callers don't have to
 * know which Mongoose fields exist on the model.
 */

import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { buildNameRosterQuery } from '../../utils/listEntryMap.js';

/**
 * Project a Blacklist/Whitelist entry to the slim shape the embeds
 * + handler code consume. Centralises field defaults so adding a new
 * field on the model only touches this file (plus the new use site).
 * @param {object} entry - Mongoose lean document
 * @returns {object} normalised hit payload
 */
export function shapeRosterListHit(entry) {
  return {
    name: entry.name,
    reason: entry.reason ?? '',
    raid: entry.raid ?? '',
    logsUrl: entry.logsUrl ?? '',
    imageUrl: entry.imageUrl ?? '',
    imageMessageId: entry.imageMessageId ?? '',
    imageChannelId: entry.imageChannelId ?? '',
    allCharacters: entry.allCharacters ?? [],
    addedAt: entry.addedAt ?? null,
    addedByDisplayName: entry.addedByDisplayName ?? '',
    addedByName: entry.addedByName ?? '',
    addedByTag: entry.addedByTag ?? '',
    addedByUserId: entry.addedByUserId ?? '',
    scope: entry.scope ?? '',
    guildId: entry.guildId ?? '',
  };
}

/**
 * Look up a roster's names against the Blacklist collection.
 * Returns the FIRST hit (sorted by scope DESC · guild > global) so
 * server-scoped entries take precedence over global ones.
 * @param {string[]} names - character names from the OCR/roster
 * @param {{guildId?: string}} [options] - scope filter
 * @returns {Promise<object|null>} shaped hit or null on no match / error
 */
export async function handleRosterBlackListCheck(names, options = {}) {
  try {
    await connectDB();

    const { guildId } = options;
    const nameQuery = buildNameRosterQuery(names);

    const entry = await Blacklist.findOne(buildBlacklistQuery(nameQuery, guildId))
      .sort({ scope: -1 })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[blacklist] "${entry.name}" is BLACKLISTED - reason: ${entry.reason || '(none)'}`);
      return shapeRosterListHit(entry);
    }

    console.log('[blacklist] No blacklisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[blacklist] Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

export async function handleRosterWhiteListCheck(names) {
  try {
    console.log(`[whitelist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDB();

    const entry = await Whitelist.findOne(buildNameRosterQuery(names))
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (entry) {
      console.log(`[whitelist] "${entry.name}" is WHITELISTED - reason: ${entry.reason || '(none)'}`);
      return shapeRosterListHit(entry);
    }

    console.log('[whitelist] No whitelisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[whitelist] Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    return null;
  }
}

export function buildRosterStatusContent(name, result, label) {
  const reason = result.reason ? ` - *${result.reason}*` : '';
  const raid = result.raid ? ` [${result.raid}]` : '';
  return `${label} **${name}**${label === '⛔' ? ' is on the blacklist.' : ' is on the whitelist.'}${raid}${reason}`;
}
