/**
 * RosterCache.js
 * Caches roster check results from lostark.bible to avoid repeated HTTP requests.
 * Same character appearing in multiple screenshots will hit cache instead of fetching again.
 * TTL 24h — auto-expires so data stays reasonably fresh.
 */

import mongoose from 'mongoose';

const rosterCacheSchema = new mongoose.Schema({
  /** Character name (case-insensitive lookup via collation) */
  name: { type: String, required: true, trim: true },

  /** Whether the character has a visible roster on lostark.bible */
  hasRoster: { type: Boolean, default: false },

  /** All characters on the same roster (alts) */
  allCharacters: { type: [String], default: [] },

  /** Reason for failure if roster not found (e.g. "HTTP 403", "Rate limited") */
  failReason: { type: String, default: '' },

  /** Cached search suggestions for names without roster (diacritics correction) */
  searchSuggestions: { type: [{ name: String, flag: String }], default: [] },

  /** When this cache entry was created — TTL index expires after 24h */
  cachedAt: { type: Date, default: Date.now, expires: 86400 },
});

rosterCacheSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export default mongoose.model('RosterCache', rosterCacheSchema);
