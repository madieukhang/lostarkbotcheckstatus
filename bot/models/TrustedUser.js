/**
 * TrustedUser.js
 * Characters that are trusted and cannot be added to the blacklist.
 * Only officers/seniors can manage this list.
 */

import mongoose from 'mongoose';

const trustedUserSchema = new mongoose.Schema({
  /** Character name (main) */
  name: { type: String, required: true, trim: true },

  /** Reason for trust (e.g. "Guild officer", "Known veteran") */
  reason: { type: String, default: '', trim: true },

  /** Full roster snapshot used to trust every alt on the same account */
  allCharacters: { type: [String], default: [] },

  /**
   * Where `allCharacters` was last touched from. Mirrors the list-entry
   * schemas so trusted entries can participate in the same stale-data
   * reasoning later.
   */
  enrichmentSource: {
    type: String,
    enum: ['bible', 'manual', 'local-sync', null],
    default: null,
  },

  /** Timestamp of the most recent `allCharacters` write. */
  enrichedAt: { type: Date, default: null },

  /** Who added this trusted entry */
  addedByUserId: { type: String, default: '' },
  addedByTag: { type: String, default: '' },

  /** When this entry was added */
  addedAt: { type: Date, default: Date.now },
});

// Case-insensitive unique index (matches collation used in lookups)
trustedUserSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);
trustedUserSchema.index({ allCharacters: 1 });

export default mongoose.model('TrustedUser', trustedUserSchema);
