import { randomUUID } from 'node:crypto';

import PendingApproval from '../../../models/PendingApproval.js';

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
    title: 'List Edit — Approval Required',
  });

  if (!sent.success) {
    await interaction.editReply({ content: `⚠️ ${sent.reason}` });
    return;
  }

  await PendingApproval.create({
    ...payload,
    approverIds: sent.deliveredApproverIds,
    approverDmMessages: sent.deliveredDmMessages,
  });

  await interaction.editReply({
    content: `📨 Edit request sent for approval.\nChanges:\n${changes.map((c) => `• ${c}`).join('\n')}`,
  });
}
