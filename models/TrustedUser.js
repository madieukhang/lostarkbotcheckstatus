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

export default mongoose.model('TrustedUser', trustedUserSchema);
