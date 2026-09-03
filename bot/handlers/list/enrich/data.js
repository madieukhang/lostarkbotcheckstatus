import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import { pickPreferredListEntry } from '../../../utils/listEntryMap.js';
import { buildBlacklistQuery } from '../../../utils/scope.js';
import { COLORS } from '../../../utils/ui.js';

const COLLATION = { locale: 'en', strength: 2 };

// Note: watchlist uses 👁️ (not the canonical ⚠️ from getListContext) on
// purpose - the enrich UI emphasises the "under observation" aspect of
// watch entries since enrich-discovered alts are often the reason an
// entry gets watched in the first place.
export const LIST_LABELS = {
  black: { label: 'blacklist', icon: '⛔', color: COLORS.danger  },
  white: { label: 'whitelist', icon: '✅', color: COLORS.success },
  watch: { label: 'watchlist', icon: '👁️', color: COLORS.warning },
};

export const MODELS_BY_TYPE = {
  black: Blacklist,
  white: Whitelist,
  watch: Watchlist,
};

export async function findEntryByName(name, guildId = '') {
  const query = { name };
  const [blackEntries, white, watch] = await Promise.all([
    Blacklist.find(buildBlacklistQuery(query, guildId)).collation(COLLATION).lean(),
    Whitelist.findOne(query).collation(COLLATION).lean(),
    Watchlist.findOne(query).collation(COLLATION).lean(),
  ]);
  const black = pickPreferredListEntry(blackEntries, [name], {
    preferServerScope: true,
    preferredGuildId: guildId,
  });
  return [
    { type: 'black', entry: black },
    { type: 'white', entry: white },
    { type: 'watch', entry: watch },
  ].find(({ entry }) => Boolean(entry)) || null;
}
