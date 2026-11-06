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
});

export default mongoose.model('evidence_image', evidenceImageSchema, 'evidence_images');
