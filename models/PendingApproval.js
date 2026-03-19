/**
 * models/PendingApproval.js
 * Mongoose schema for persisting /list add approval requests.
 * Documents auto-expire after 24 hours via TTL index.
 */

import mongoose from 'mongoose';

const pendingApprovalSchema = new mongoose.Schema({
  /** UUID identifying this approval request */
  requestId: {
    type: String,
    required: true,
    unique: true,
  },

  guildId: { type: String, required: true },
  channelId: { type: String, required: true },
  type: { type: String, required: true },
  name: { type: String, required: true },
  reason: { type: String, default: '' },
  raid: { type: String, default: '' },
  imageUrl: { type: String, default: '' },

  requestedByUserId: { type: String, required: true },
  requestedByTag: { type: String, default: '' },
  requestedByName: { type: String, default: '' },
  requestedByDisplayName: { type: String, default: '' },

  /** Message ID of the requester's original reply (for threading) */
  requestMessageId: { type: String, default: '' },

  /** Discord user IDs that received approval DMs */
  approverIds: { type: [String], default: [] },

  /** References to the DM messages sent to approvers */
  approverDmMessages: [
    {
      _id: false,
      approverId: String,
      channelId: String,
      messageId: String,
    },
  ],

  /** TTL: auto-delete after 24 hours */
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 86400,
  },
});

export default mongoose.model('PendingApproval', pendingApprovalSchema, 'pending_approvals');
