import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
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

export async function findEntryByName(name) {
  const black = await Blacklist.findOne({ name }).collation(COLLATION).lean();
  if (black) return { type: 'black', entry: black };
  const white = await Whitelist.findOne({ name }).collation(COLLATION).lean();
  if (white) return { type: 'white', entry: white };
  const watch = await Watchlist.findOne({ name }).collation(COLLATION).lean();
  if (watch) return { type: 'watch', entry: watch };
  return null;
}
