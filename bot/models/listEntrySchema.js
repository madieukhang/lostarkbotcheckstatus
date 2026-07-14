/**
 * Shared document shape for blacklist, whitelist, and watchlist entries.
 * Blacklist opts into scope fields and a compound unique index; the other
 * collections keep their historical name-only unique index.
 */

import mongoose from 'mongoose';

const CASE_INSENSITIVE_COLLATION = Object.freeze({ locale: 'en', strength: 2 });

function buildCommonFields() {
  return {
    name: { type: String, required: true, trim: true },
    reason: { type: String, default: '', trim: true },
    raid: { type: String, default: '', trim: true },
    logsUrl: { type: String, default: '', trim: true },

    // `imageUrl` is the legacy expiring Discord CDN field. New entries store
    // the evidence message/channel ids and resolve a fresh URL on demand.
    imageUrl: { type: String, default: '', trim: true },
    imageMessageId: { type: String, default: '', trim: true },
    imageChannelId: { type: String, default: '', trim: true },

    allCharacters: { type: [String], default: [] },
    enrichmentSource: {
      type: String,
      enum: ['bible', 'manual', 'local-sync', null],
      default: null,
    },
    enrichedAt: { type: Date, default: null },

    addedByUserId: { type: String, default: '', trim: true },
    addedByTag: { type: String, default: '', trim: true },
    addedByName: { type: String, default: '', trim: true },
    addedByDisplayName: { type: String, default: '', trim: true },
    addedAt: { type: Date, default: Date.now },
  };
}

export function createListEntrySchema({ scoped = false } = {}) {
  const fields = buildCommonFields();
  if (scoped) {
    fields.scope = {
      type: String,
      enum: ['global', 'server'],
      default: 'global',
    };
    fields.guildId = { type: String, default: '' };
  }

  const schema = new mongoose.Schema(fields);
  schema.index(
    scoped ? { name: 1, scope: 1, guildId: 1 } : { name: 1 },
    { unique: true, collation: CASE_INSENSITIVE_COLLATION }
  );
  schema.index({ allCharacters: 1 });
  schema.index({ addedAt: -1 });
  return schema;
}
