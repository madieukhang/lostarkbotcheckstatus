/**
 * services/roster/listChecks.js
 * Roster-vs-list lookup helpers backing /la-roster.
 * Blacklist + whitelist queries are case-insensitive (collation
 * strength 2) so OCR-folded names land on the right row. Returns the
 * full entry shape via shapeRosterListHit so callers don't have to
 * know which Mongoose fields exist on the model.
 */

import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import {
  buildNameRosterQuery,
  pickPreferredListEntry,
} from '../../utils/listEntryMap.js';
import { CASE_INSENSITIVE_COLLATION } from '../../models/collation.js';

/**
 * Project a Blacklist/Whitelist entry to the slim shape the embeds
 * + handler code consume. Centralises field defaults so adding a new
 * field on the model only touches this file (plus the new use site).
 * @param {object} entry - Mongoose lean document
 * @returns {object} normalised hit payload
 */
export function shapeRosterListHit(entry) {
  return {
    _id: entry._id,
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
 * Fetches every matching row, then applies the shared deterministic priority:
 * requesting guild Server > another owner-visible Server > Global/legacy;
 * exact primary > roster alias inside one scope tier.
 * A lookup error is rethrown: a null here reads as "not blacklisted".
 * @param {string[]} names - character names from the OCR/roster
 * @param {object} [options]
 * @param {string} [options.guildId] - scope filter
 * @param {object} [options.BlacklistModel] - Blacklist model
 * @param {Function} [options.connectDBFn] - database connector
 * @returns {Promise<object|null>} shaped hit, or null on no match
 */
export async function handleRosterBlackListCheck(names, {
  guildId,
  BlacklistModel = Blacklist,
  connectDBFn = connectDB,
} = {}) {
  try {
    await connectDBFn();

    const nameQuery = buildNameRosterQuery(names);

    const entries = await BlacklistModel.find(buildBlacklistQuery(nameQuery, guildId))
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean();
    const entry = pickPreferredListEntry(entries, names, {
      preferServerScope: true,
      preferredGuildId: guildId,
    });

    if (entry) {
      console.log(`[blacklist] "${entry.name}" is BLACKLISTED - reason: ${entry.reason || '(none)'}`);
      return shapeRosterListHit(entry);
    }

    console.log('[blacklist] No blacklisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[blacklist] Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    throw err;
  }
}

/**
 * Look up a roster's names against the Whitelist collection.
 * A lookup error is rethrown, as for the blacklist check.
 * @param {string[]} names - character names from the OCR/roster
 * @param {object} [options]
 * @param {object} [options.WhitelistModel] - Whitelist model
 * @param {Function} [options.connectDBFn] - database connector
 * @returns {Promise<object|null>} shaped hit, or null on no match
 */
export async function handleRosterWhiteListCheck(names, {
  WhitelistModel = Whitelist,
  connectDBFn = connectDB,
} = {}) {
  try {
    console.log(`[whitelist] Checking ${names.length} character(s):`, names.join(', '));
    await connectDBFn();

    const entry = await WhitelistModel.findOne(buildNameRosterQuery(names))
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean();

    if (entry) {
      console.log(`[whitelist] "${entry.name}" is WHITELISTED - reason: ${entry.reason || '(none)'}`);
      return shapeRosterListHit(entry);
    }

    console.log('[whitelist] No whitelisted characters found in roster');
    return null;
  } catch (err) {
    console.error('[whitelist] Check failed:', err.message, '| code:', err.code, '| name:', err.name);
    throw err;
  }
}
