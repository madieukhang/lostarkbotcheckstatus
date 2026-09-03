import Blacklist from '../../models/Blacklist.js';
import TrustedUser from '../../models/TrustedUser.js';
import Watchlist from '../../models/Watchlist.js';
import Whitelist from '../../models/Whitelist.js';
import { buildListEntryMaps, buildNameRosterQuery } from '../../utils/listEntryMap.js';
import { buildBlacklistQuery } from '../../utils/scope.js';

export const LIST_LOOKUP_COLLATION = Object.freeze({ locale: 'en', strength: 2 });

/**
 * Execute the shared bulk list lookup used by search and both image/text check.
 * Keeping blacklist scoping and map precedence here prevents those surfaces
 * from drifting while still issuing the four independent Mongo queries in
 * parallel.
 */
export async function loadListLookup(names, { guildId } = {}) {
  const nameQuery = buildNameRosterQuery(names);
  const [black, white, watch, trusted] = await Promise.all([
    Blacklist.find(buildBlacklistQuery(nameQuery, guildId))
      .collation(LIST_LOOKUP_COLLATION)
      .lean(),
    Whitelist.find(nameQuery).collation(LIST_LOOKUP_COLLATION).lean(),
    Watchlist.find(nameQuery).collation(LIST_LOOKUP_COLLATION).lean(),
    TrustedUser.find(nameQuery).collation(LIST_LOOKUP_COLLATION).lean(),
  ]);
  const entries = { black, white, watch, trusted };
  return { maps: buildListEntryMaps(entries, { preferredGuildId: guildId }) };
}
