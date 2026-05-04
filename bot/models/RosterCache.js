/**
 * RosterCache.js
 * Caches roster check results from lostark.bible to avoid repeated HTTP requests.
 * Same character appearing in multiple screenshots will hit cache instead of fetching again.
 * TTL 24h · auto-expires so data stays reasonably fresh.
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

  /**
   * Target character display tokens captured during the same roster
   * scrape that populated `hasRoster` / `allCharacters`. Lets cache
   * hits in `/la-list check` and auto-check render the class icon +
   * ilvl + CP without falling back to RosterSnapshot or a fresh
   * roster fetch · v0.5.71 fix for the "cache hit but no class data"
   * bug observed when names had been checked before v0.5.70.
   */
  targetClassName: { type: String, default: '' },
  targetItemLevel: { type: Number, default: 0 },
  targetCombatScore: { type: String, default: '' },

  /** When this cache entry was created · TTL index expires after 24h */
  cachedAt: { type: Date, default: Date.now, expires: 86400 },
});

rosterCacheSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

rosterCacheSchema.index({ allCharacters: 1 });

export default mongoose.model('RosterCache', rosterCacheSchema);
