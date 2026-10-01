/**
 * Shared document shape for blacklist, whitelist, and watchlist entries.
 * Blacklist opts into scope fields and a compound unique index; the other
 * collections keep their historical name-only unique index.
 */

import mongoose from 'mongoose';

const CASE_INSENSITIVE_COLLATION = Object.freeze({ locale: 'en', strength: 2 });

export function buildRosterIdentityFields() {
  return {
    name: { type: String, required: true, trim: true },
    reason: { type: String, default: '', trim: true },
    allCharacters: { type: [String], default: [] },
    enrichmentSource: {
      type: String,
      enum: ['bible', 'manual', 'local-sync', null],
      default: null,
    },
    enrichedAt: { type: Date, default: null },

    addedByUserId: { type: String, default: '' },
    addedByTag: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
  };
}

function buildCommonFields() {
  return {
    ...buildRosterIdentityFields(),
    raid: { type: String, default: '', trim: true },
    logsUrl: { type: String, default: '', trim: true },
    // Report history, oldest first. `reason` and `raid` above mirror the
    // last note; an entry without notes reads its add as the only note.
    notes: {
      type: [{
        _id: false,
        at: { type: Date },
        reason: { type: String, default: '', trim: true },
        raid: { type: String, default: '', trim: true },
        byUserId: { type: String, default: '', trim: true },
        byName: { type: String, default: '', trim: true },
      }],
      default: [],
    },

    // `imageUrl` is the legacy expiring Discord CDN field. New entries store
    // the evidence message/channel ids and resolve a fresh URL on demand.
    imageUrl: { type: String, default: '', trim: true },
    imageMessageId: { type: String, default: '', trim: true },
    imageChannelId: { type: String, default: '', trim: true },

    addedByUserId: { type: String, default: '', trim: true },
    addedByTag: { type: String, default: '', trim: true },
    addedByName: { type: String, default: '', trim: true },
    addedByDisplayName: { type: String, default: '', trim: true },
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
  if (scoped) {
    // Blacklist checks combine roster aliases with global/server visibility.
    // Matching the query collation and scope fields lets Mongo satisfy both
    // halves without scanning every alias hit before applying guild scope.
    schema.index(
      { allCharacters: 1, scope: 1, guildId: 1 },
      { collation: CASE_INSENSITIVE_COLLATION }
    );
  } else {
    // Alias lookups run with the case-insensitive collation, and Mongo
    // skips an index whose collation differs. The name lets this index sit
    // beside the uncollated allCharacters_1 already in the database, which
    // autoIndex creates around but never replaces.
    schema.index(
      { allCharacters: 1 },
      { collation: CASE_INSENSITIVE_COLLATION, name: 'allCharacters_ci' }
    );
  }
  schema.index({ addedAt: -1 });
  return schema;
}
