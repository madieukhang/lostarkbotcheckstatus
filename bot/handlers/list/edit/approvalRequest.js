/**
 * handlers/list/edit/approvalRequest.js
 * Non-officer branch of /la-list edit · creates a PendingApproval doc
 * with kind="edit" and fans out the approval DM to approvers using
 * the SAME sendListAddApprovalToApprovers helper as /la-list add
 * (so the approver UX stays consistent across add + edit).
 */

import { randomUUID } from 'node:crypto';

import PendingApproval from '../../../models/PendingApproval.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { editAlert } from '../../../utils/interactionReplies.js';

/**
 * Persist a /la-list edit request as a PendingApproval and fan out the
 * approval DM to every assigned approver.
 * @param {object} args - the edit-request context bag
 * @param {import('discord.js').Interaction} args.interaction
 * @param {Function} args.sendListAddApprovalToApprovers - reused
 *   approver DM broadcaster (handles both add + edit kinds)
 * @param {object} args.existing - the entry being edited
 * @param {string} args.currentType - blacklist | whitelist | watchlist
 * @param {string} args.targetType - destination list type
 *   · plus the rewritten payload fields (newReason, newRaid, newLogs,
 *   newScope, newImage, additional_names, etc.)
 * @returns {Promise<void>}
 */
export async function sendListEditApprovalRequest({
  interaction,
  sendListAddApprovalToApprovers,
  existing,
  currentType,
  targetType,
  newReason,
  newRaid,
  newLogs,
  newImageUrl,
  newImageRehost,
  newScope,
  editGuildDefaultScope,
  changes,
}) {

  // Not owner, not approver → send approval request
  const existingObj = existing.toObject?.() || existing;

  // Image fields for the approval payload: prefer rehosted refs over URL.
  // The newImageRehost was already attempted at the top of the handler.
  const editImageFields = newImageUrl
    ? (newImageRehost
        ? { imageUrl: newImageRehost.freshUrl || '', imageMessageId: newImageRehost.messageId, imageChannelId: newImageRehost.channelId }
        : { imageUrl: newImageUrl, imageMessageId: '', imageChannelId: '' })
    : { imageUrl: existing.imageUrl || '', imageMessageId: existing.imageMessageId || '', imageChannelId: existing.imageChannelId || '' };

  const payload = {
    requestId: randomUUID(),
    action: 'edit',
    existingEntryId: String(existingObj._id),
    currentType,
    guildId: interaction.guild.id,
    channelId: interaction.channelId,
    type: targetType,
    name: existing.name,
    reason: newReason || existing.reason,
    raid: newRaid || existing.raid,
    logsUrl: newLogs || existing.logsUrl || '',
    ...editImageFields,
    // Scope priority: explicit user option → existing entry's scope → guild default.
    // The approval handler at line ~1206 (cross-list move) and ~1230 (in-place)
    // both honor payload.scope when persisting the edit.
    scope: newScope || existingObj.scope || editGuildDefaultScope,
    requestedByUserId: interaction.user.id,
    requestedByTag: interaction.user.tag,
    requestedByName: interaction.user.username,
    requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
    createdAt: Date.now(),
  };

  const sent = await sendListAddApprovalToApprovers(interaction.guild, payload, {
    title: 'List Edit · Approval Required',
  });

  if (!sent.success) {
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      title: 'Approval Delivery Failed',
      description: sent.reason || 'Could not deliver the approval request.',
      footer: 'No edit was applied. Try again or contact an officer directly.',
    });
    return;
  }

  await PendingApproval.create({
    ...payload,
    approverIds: sent.deliveredApproverIds,
    approverDmMessages: sent.deliveredDmMessages,
  });

  await editAlert(interaction, {
    severity: AlertSeverity.INFO,
    titleIcon: '📨',
    title: 'Edit Request Sent',
    description: 'An approver has been notified. The edit will apply once approved.',
    fields: [{
      name: `Pending changes (${changes.length})`,
      value: changes.map((c) => `• ${c}`).join('\n').slice(0, 1024),
      inline: false,
    }],
  });
}
