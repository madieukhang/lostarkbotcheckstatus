/**
 * Database copy of an evidence image, the second layer beside the evidence
 * channel archive. One document per distinct image, keyed by the SHA-256 of
 * its bytes, so a screenshot used for two entries is stored once.
 * `archiveMessageIds` keeps every evidence-channel message the image has had,
 * so an entry or an old broadcast button that points at a deleted message
 * still finds the image.
 */

import mongoose from 'mongoose';

const evidenceImageSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  data: { type: Buffer, required: true },
  contentType: { type: String, default: '' },
  size: { type: Number, default: 0 },
  filename: { type: String, default: '' },
  archiveMessageIds: { type: [String], default: [], index: true },
  archiveChannelId: { type: String, default: '' },
  archiveMessageId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  // Set when a member's request stored the image before any approval; the
  // evidence sweep clears it once an entry or request points at the image,
  // and removes the image when nothing has after a while.
  pending: { type: Boolean, default: false, index: true },
  // Bumped on every store, so a fresh upload of the same bytes restarts the age.
  lastStoredAt: { type: Date, default: Date.now },
});

export default mongoose.model('evidence_image', evidenceImageSchema, 'evidence_images');
