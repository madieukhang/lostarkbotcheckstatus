/**
 * models/Watchlist.js
 * Mongoose schema for the roster watchlist (under investigation).
 * Same structure as Blacklist/Whitelist but used for suspicious characters
 * that don't have enough evidence for a full blacklist entry yet.
 */

import mongoose from 'mongoose';

const watchlistSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  reason: { type: String, default: '', trim: true },
  raid: { type: String, default: '', trim: true },
  logsUrl: { type: String, default: '', trim: true },
  // Legacy URL field · replaced by imageMessageId/imageChannelId for new entries
  imageUrl: { type: String, default: '', trim: true },
  imageMessageId: { type: String, default: '', trim: true },
  imageChannelId: { type: String, default: '', trim: true },
  allCharacters: { type: [String], default: [] },
  addedByUserId: { type: String, default: '', trim: true },
  addedByTag: { type: String, default: '', trim: true },
  addedByName: { type: String, default: '', trim: true },
  addedByDisplayName: { type: String, default: '', trim: true },
  addedAt: { type: Date, default: Date.now },
});

watchlistSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

watchlistSchema.index({ allCharacters: 1 });

export default mongoose.model('watchlist', watchlistSchema, 'watchlist');
