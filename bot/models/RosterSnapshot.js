/**
 * models/RosterSnapshot.js
 * Stores item level snapshots for characters to track progression over time.
 * Each document represents one character's latest known state.
 */

import mongoose from 'mongoose';

const rosterSnapshotSchema = new mongoose.Schema({
  /** Character name (unique per snapshot) */
  name: { type: String, required: true, trim: true },

  /** Item level at time of snapshot */
  itemLevel: { type: Number, default: 0 },

  /** Class ID from lostark.bible */
  classId: { type: String, default: '' },

  /** Combat score at time of snapshot */
  combatScore: { type: String, default: '' },

  /** The roster/account this character belongs to (main character name) */
  rosterName: { type: String, default: '', trim: true },

  /** When this snapshot was last updated */
  updatedAt: { type: Date, default: Date.now },
});

rosterSnapshotSchema.index(
  { name: 1 },
  { unique: true, collation: { locale: 'en', strength: 2 } }
);

rosterSnapshotSchema.index({ rosterName: 1 });

export default mongoose.model('RosterSnapshot', rosterSnapshotSchema, 'roster_snapshots');
