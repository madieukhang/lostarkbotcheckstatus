import Blacklist from '../../models/Blacklist.js';
import TrustedUser from '../../models/TrustedUser.js';
import Watchlist from '../../models/Watchlist.js';
import Whitelist from '../../models/Whitelist.js';
import { buildListEntryMaps, buildNameRosterQuery } from '../../utils/listEntryMap.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { CASE_INSENSITIVE_COLLATION } from '../../models/collation.js';

// Summary cards use the mirrored latest report. Detail clicks reload the full entry.
const LIST_SUMMARY_PROJECTION = { notes: 0 };

/**
 * Execute the shared bulk list lookup used by search and both image/text check.
 * Keeping blacklist scoping and map precedence here prevents those surfaces
 * from drifting while still issuing the four independent Mongo queries in
 * parallel.
 * @param {string[]} names - primary and alias names to check
 * @param {{ guildId?: string }} [options] - requesting guild for blacklist visibility
 * @returns {Promise<{ maps: object }>} summary entries indexed by normalized name
 */
export async function loadListLookup(names, { guildId } = {}) {
  const nameQuery = buildNameRosterQuery(names);
  const [black, white, watch, trusted] = await Promise.all([
    Blacklist.find(buildBlacklistQuery(nameQuery, guildId), LIST_SUMMARY_PROJECTION)
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean(),
    Whitelist.find(nameQuery, LIST_SUMMARY_PROJECTION).collation(CASE_INSENSITIVE_COLLATION).lean(),
    Watchlist.find(nameQuery, LIST_SUMMARY_PROJECTION).collation(CASE_INSENSITIVE_COLLATION).lean(),
    TrustedUser.find(nameQuery).collation(CASE_INSENSITIVE_COLLATION).lean(),
  ]);
  const entries = { black, white, watch, trusted };
  return { maps: buildListEntryMaps(entries, { preferredGuildId: guildId }) };
}
