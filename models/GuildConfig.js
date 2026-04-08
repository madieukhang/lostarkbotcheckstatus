/**
 * GuildConfig.js
 * Per-guild configuration for auto-check and notification channels.
 * Allows each Discord server to set its own channels via /lasetup,
 * with environment variables as global fallback.
 */

import mongoose from 'mongoose';

const guildConfigSchema = new mongoose.Schema({
  /** Discord guild (server) ID — one config per guild */
  guildId: { type: String, required: true, unique: true },

  /** Channel ID where screenshots are auto-checked (OCR → list check) */
  autoCheckChannelId: { type: String, default: '' },

  /** Channel ID where list add/remove notifications are broadcast */
  listNotifyChannelId: { type: String, default: '' },

  /** Whether this guild receives global list notifications from other servers */
  globalNotifyEnabled: { type: Boolean, default: true },

  /** Who last updated this config */
  updatedByUserId: { type: String, default: '' },
  updatedByTag: { type: String, default: '' },
}, {
  timestamps: true,
});

export default mongoose.model('GuildConfig', guildConfigSchema);
