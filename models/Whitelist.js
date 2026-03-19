/**
 * models/Whitelist.js
 * Mongoose schema for the roster whitelist.
 */

import mongoose from 'mongoose';

const whitelistSchema = new mongoose.Schema({
  /** Character name — unique index defined via schema.index() below (case-insensitive) */
  name: {
    type: String,
    required: true,
    trim: true,
  },

  /** Optional reason for the whitelist entry */
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

  /** Timestamp of when the entry was added */
  addedAt: {
    type: Date,
    default: Date.now,
  },
});

// Case-insensitive collation index so lookups ignore capitalisation
whitelistSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

export default mongoose.model('whitelist', whitelistSchema, 'whitelist');
