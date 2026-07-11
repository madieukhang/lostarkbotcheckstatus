/**
 * GuildConfig.js
 * Per-guild configuration for auto-check and notification channels.
 * Allows each Discord server to set its own channels via /la-setup,
 * with environment variables as global fallback.
 */

import mongoose from 'mongoose';

const guildConfigSchema = new mongoose.Schema({
  /** Discord guild (server) ID · one config per guild */
  guildId: { type: String, required: true, unique: true },

  /** Per-guild locale for future public responses/announcements */
  language: { type: String, default: 'en' },

  /** Channel ID where screenshots are auto-checked (OCR → list check) */
  autoCheckChannelId: { type: String, default: '' },

  /** Tracked Artist welcome pin for the auto-check channel */
  autoCheckWelcomeMessageId: { type: String, default: '' },
  autoCheckWelcomeChannelId: { type: String, default: '' },

  /** Destructive daily cleanup is opt-in per guild; auto-check stays independent */
  autoCheckCleanupEnabled: { type: Boolean, default: false },

  /** YYYY-MM-DD in Asia/Ho_Chi_Minh for the last completed daily cleanup */
  lastAutoCheckCleanupKey: { type: String, default: '' },

  /** Channel ID where list add/remove notifications are broadcast */
  listNotifyChannelId: { type: String, default: '' },

  /** Whether this guild receives global list notifications from other servers */
  globalNotifyEnabled: { type: Boolean, default: true },

   /** Default blacklist scope for /la-list add when scope option is not specified */
  defaultBlacklistScope: { type: String, enum: ['global', 'server'], default: 'global' },

  /**
   * Channel ID where the bot rehosts evidence images for permanent storage.
   * Only meaningful on the OWNER guild's GuildConfig record · bot reads this
   * single value to know where to upload images. Configured via /la-remote
   * action:evidencechannel channel:#... by Senior approvers. Without it,
   * /la-list add image uploads fall back to legacy direct-URL storage which
   * expires after ~24h due to Discord CDN policy.
   */
  evidenceChannelId: { type: String, default: '' },

  /** Who last updated this config */
  updatedByUserId: { type: String, default: '' },
  updatedByTag: { type: String, default: '' },
}, {
  timestamps: true,
});

export default mongoose.model('GuildConfig', guildConfigSchema);
