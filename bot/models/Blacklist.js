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
   * Optional attachment image URL — legacy field. New entries (from rehost-aware
   * /la-list add) leave this empty and use imageMessageId/imageChannelId instead.
   * Old entries created before the rehost feature still have URL here, but
   * the URL likely expired due to Discord CDN policy. Kept for backward compat
   * and graceful display fallback.
   */
  imageUrl: {
    type: String,
    default: '',
    trim: true,
  },

  /**
   * ID of the message in the evidence channel that holds the rehosted image.
   * Empty for legacy entries (use imageUrl) and entries with no evidence.
   * Bot fetches this message on demand to get a fresh signed URL since
   * Discord CDN URLs expire ~24h after issue.
   */
  imageMessageId: {
    type: String,
    default: '',
    trim: true,
  },

  /** ID of the evidence channel where the rehosted image lives. */
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

  /** Scope: 'global' (shared across all servers) or 'server' (per-guild only) */
  scope: {
    type: String,
    enum: ['global', 'server'],
    default: 'global',
  },

  /** Guild ID — only set when scope is 'server' */
  guildId: {
    type: String,
    default: '',
  },
});

// Compound unique index: same name can exist in global + different servers
blacklistSchema.index(
  { name: 1, scope: 1, guildId: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

// Index on allCharacters for fast $in lookups during roster/la-check cross-checks
blacklistSchema.index({ allCharacters: 1 });

export default mongoose.model('blacklist', blacklistSchema, 'blacklist');
