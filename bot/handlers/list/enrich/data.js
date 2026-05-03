import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';

const COLLATION = { locale: 'en', strength: 2 };

export const LIST_LABELS = {
  black: { label: 'blacklist', icon: '⛔', color: 0xed4245 },
  white: { label: 'whitelist', icon: '✅', color: 0x57f287 },
  watch: { label: 'watchlist', icon: '👁️', color: 0xfee75c },
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
