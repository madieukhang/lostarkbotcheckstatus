/**
 * models/PendingApproval.js
 * Mongoose schema for persisting /la-list add approval requests.
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
  // type/name required for single add+edit, optional for bulk (rows carry their own)
  type: {
    type: String,
    required: function () { return this.action !== 'bulk'; },
    default: '',
  },
  name: {
    type: String,
    required: function () { return this.action !== 'bulk'; },
    default: '',
  },
  reason: { type: String, default: '' },
  raid: { type: String, default: '' },
  logsUrl: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  // Rehost refs · populated when image was rehosted to evidence channel.
  // If set, the persisted entry will use these instead of imageUrl, so the
  // approval flow preserves rehost permanence end-to-end.
  imageMessageId: { type: String, default: '' },
  imageChannelId: { type: String, default: '' },

  /** Blacklist scope: 'global' or 'server' */
  scope: { type: String, enum: ['global', 'server'], default: 'global' },

  /** Action type: 'add' (single), 'edit' (single), or 'bulk' (multiadd batch) */
  action: { type: String, enum: ['add', 'edit', 'bulk'], default: 'add' },

  /** For edit actions: _id of the entry being edited */
  existingEntryId: { type: String, default: '' },

  /** For edit actions: the original list type before edit */
  currentType: { type: String, default: '' },

  /** For overwrite flow: _id of the duplicate entry to delete */
  duplicateEntryId: { type: String, default: '' },

  /**
   * For action='bulk': parsed rows from /la-list multiadd upload waiting for approval.
   * Empty for single add/edit actions. Each row mirrors the payload shape used
   * by executeListAddToDatabase, minus requester info (which lives on the parent doc).
   */
  bulkRows: {
    type: [
      {
        _id: false,
        name: { type: String, required: true },
        type: { type: String, required: true },
        reason: { type: String, default: '' },
        raid: { type: String, default: '' },
        logsUrl: { type: String, default: '' },
        imageUrl: { type: String, default: '' },
        // Rehost refs per row · populated at submit time so member approval
        // flow does not need to re-download URLs that may have already
        // expired by the time Senior approves the batch.
        imageMessageId: { type: String, default: '' },
        imageChannelId: { type: String, default: '' },
        scope: { type: String, default: '' },
      },
    ],
    default: [],
  },

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
