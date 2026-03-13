/**
 * models/Blacklist.js
 * Mongoose schema for the roster blacklist.
 *
 * Each document represents one blacklisted character name.
 * Example MongoDB document:
 *   { name: "Lazy", reason: "RMT", addedAt: ISODate("...") }
 */

import mongoose from 'mongoose';

const blacklistSchema = new mongoose.Schema({
  /** Character name — unique index defined via schema.index() below (case-insensitive) */
  name: {
    type: String,
    required: true,
    trim: true,
  },

  /** Optional reason for the blacklist entry */
  reason: {
    type: String,
    default: '',
    trim: true,
  },

  /** Optional attachment image URL from slash command */
  imageUrl: {
    type: String,
    default: '',
    trim: true,
  },

  /** Full 1640+ roster snapshot used to detect future existed matches */
  allCharacters: {
    type: [String],
    default: [],
  },

  /** Timestamp of when the entry was added */
  addedAt: {
    type: Date,
    default: Date.now,
  },
});

// Case-insensitive collation index so lookups ignore capitalisation
blacklistSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export default mongoose.model('blacklists', blacklistSchema);
