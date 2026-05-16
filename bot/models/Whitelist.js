/**
 * models/Whitelist.js
 * Mongoose schema for the roster whitelist.
 */

import mongoose from 'mongoose';

const whitelistSchema = new mongoose.Schema({
  /** Character name · unique index defined via schema.index() below (case-insensitive) */
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

  /** Optional raid tag selected from /la-list add */
  raid: {
    type: String,
    default: '',
    trim: true,
  },

  /** Optional lostark.bible logs URL */
  logsUrl: {
    type: String,
    default: '',
    trim: true,
  },

  /**
   * Optional attachment image URL · legacy field for entries created before
   * the rehost feature. New entries use imageMessageId/imageChannelId instead
   * because Discord CDN URLs expire ~24h after issue.
   */
  imageUrl: {
    type: String,
    default: '',
    trim: true,
  },

  /** Message ID in evidence channel that holds the rehosted image (rehost-aware entries). */
  imageMessageId: {
    type: String,
    default: '',
    trim: true,
  },

  /** Channel ID where the rehosted image lives. */
  imageChannelId: {
    type: String,
    default: '',
    trim: true,
  },

  /** Full 1700+ roster snapshot used to detect future existed matches */
  allCharacters: {
    type: [String],
    default: [],
  },

  /**
   * Where `allCharacters` was last touched from. See Blacklist.js for the
   * full semantics; mirrored here so all three list schemas keep the same
   * shape and `getListContext(type).model` queries stay uniform.
   */
  enrichmentSource: {
    type: String,
    enum: ['bible', 'manual', 'local-sync', null],
    default: null,
  },

  /** Timestamp of the most recent `allCharacters` write; null for legacy entries. */
  enrichedAt: {
    type: Date,
    default: null,
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
whitelistSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

// Index on allCharacters for fast $in lookups during roster/la-check cross-checks
whitelistSchema.index({ allCharacters: 1 });

export default mongoose.model('whitelist', whitelistSchema, 'whitelist');
