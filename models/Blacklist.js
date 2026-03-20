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

  /** Optional raid tag selected from /list add */
  raid: {
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

  /** Full 1680+ roster snapshot used to detect future existed matches */
  allCharacters: {
    type: [String],
    default: [],
  },

  /** Discord user id that created this entry */
  addedByUserId: {
    type: String,
    default: '',
    trim: true,
  },

  /** Discord user tag that created this entry */
  addedByTag: {
    type: String,
    default: '',
    trim: true,
  },

  /** Discord username that created this entry */
  addedByName: {
    type: String,
    default: '',
    trim: true,
  },

  /** Discord display name (server nickname/global) that created this entry */
  addedByDisplayName: {
    type: String,
    default: '',
    trim: true,
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

// Index on allCharacters for fast $in lookups during roster/listcheck cross-checks
blacklistSchema.index({ allCharacters: 1 });

export default mongoose.model('blacklist', blacklistSchema, 'blacklist');
