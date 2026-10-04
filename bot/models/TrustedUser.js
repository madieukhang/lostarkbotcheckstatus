/**
 * TrustedUser.js
 * Characters that are trusted and cannot be added to the blacklist.
 * Only officers/seniors can manage this list.
 */

import mongoose from 'mongoose';
import { buildRosterIdentityFields } from './listEntrySchema.js';
import { CASE_INSENSITIVE_COLLATION } from './collation.js';

// Trusted entries participate in the same roster-identity and enrichment
// contract as blacklist/whitelist/watchlist entries, without their evidence
// and raid-specific fields.
const trustedUserSchema = new mongoose.Schema(buildRosterIdentityFields());

// Case-insensitive unique index (matches collation used in lookups)
trustedUserSchema.index(
  { name: 1 },
  { unique: true, collation: CASE_INSENSITIVE_COLLATION }
);
// Alias lookups use the same collation. syncIndexes at startup drops the
// uncollated allCharacters_1 this replaces.
trustedUserSchema.index(
  { allCharacters: 1 },
  { collation: CASE_INSENSITIVE_COLLATION, name: 'allCharacters_ci' }
);
trustedUserSchema.index({ addedAt: -1 });

export default mongoose.model('TrustedUser', trustedUserSchema);
