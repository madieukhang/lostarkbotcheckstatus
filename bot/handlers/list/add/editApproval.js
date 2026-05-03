import PendingApproval from '../../../models/PendingApproval.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildListEditSuccessEmbed,
  buildApprovalResultRow,
} from '../helpers.js';

export async function handleApprovedEditRequest({
  client,
  interaction,
  payload,
  requestId,
  syncApproverDmMessages,
  broadcastListChange,
  notifyRequesterAboutDecision,
}) {
  const { model: oldModel } = getListContext(payload.currentType || payload.type);
  const { model: newModel, label: newLabel } = getListContext(payload.type);
  const isTypeChange = payload.currentType && payload.currentType !== payload.type;

  const existingEntry = await oldModel.findById(payload.existingEntryId);
  if (!existingEntry) {
    await PendingApproval.deleteOne({ requestId });
    await interaction.editReply({
      content: '',
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Original Entry Missing',
        description: 'The entry referenced by this approval request no longer exists - it may have been removed.',
      })],
      components: [buildApprovalResultRow('Failed')],
    });
    return;
  }

  // Captured per-branch for the rich success embed below.
  let postEditEntry = null;

  if (isTypeChange) {
    // Preflight: scope-aware duplicate check on target list
    const nameMatch = { $or: [{ name: existingEntry.name }, { allCharacters: existingEntry.name }] };
    let preflightQuery;
    if (payload.type === 'black') {
      preflightQuery = { $and: [nameMatch, { $or: [
        { scope: 'global' },
        { scope: { $exists: false } },
        { scope: 'server', guildId: payload.guildId || '' },
      ] }] };
    } else {
      preflightQuery = nameMatch;
    }
    const targetDupe = await newModel.findOne(preflightQuery)
      .collation({ locale: 'en', strength: 2 }).lean();
    if (targetDupe) {
      await PendingApproval.deleteOne({ requestId });
      await interaction.editReply({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Move Blocked',
          description: `**${existingEntry.name}** already exists in the target list. Edit aborted.`,
          footer: 'Remove the conflicting target entry first, then resubmit.',
        })],
        components: [buildApprovalResultRow('Failed')],
      });
      return;
    }

    // Recheck trusted guard at approval time (status may have changed)
    {
      const trustedNow = await TrustedUser.findOne({
        $or: [{ name: existingEntry.name }, ...(existingEntry.allCharacters?.length > 0 ? [{ name: { $in: existingEntry.allCharacters } }] : [])],
      }).collation({ locale: 'en', strength: 2 }).lean();
      if (trustedNow) {
        await PendingApproval.deleteOne({ requestId });
        await interaction.editReply({
          content: '',
          embeds: [buildTrustedBlockEmbed(existingEntry.name, trustedNow.reason)],
          components: [buildApprovalResultRow('Blocked')],
        });
        return;
      }
    }

    // Image fields: prefer new rehost from payload, fall back to existing
    // entry's rehost refs, then legacy URL. This preserves rehost
    // permanence across cross-list moves and avoids regressing rehosted
    // entries into expiring URLs.
    const moveImageMessageId = payload.imageMessageId || existingEntry.imageMessageId || '';
    const moveImageChannelId = payload.imageChannelId || existingEntry.imageChannelId || '';
    const moveImageUrl = moveImageMessageId
      ? '' // rehosted entries do not store legacy URL
      : (payload.imageUrl || existingEntry.imageUrl || '');

    // Create first, then delete old (safe order — if create fails, old preserved)
    postEditEntry = await newModel.create({
      name: existingEntry.name,
      reason: payload.reason || existingEntry.reason,
      raid: payload.raid || existingEntry.raid,
      logsUrl: payload.logsUrl || existingEntry.logsUrl,
      imageUrl: moveImageUrl,
      imageMessageId: moveImageMessageId,
      imageChannelId: moveImageChannelId,
      allCharacters: existingEntry.allCharacters || [],
      addedByUserId: existingEntry.addedByUserId,
      addedByTag: existingEntry.addedByTag,
      addedByDisplayName: existingEntry.addedByDisplayName,
      addedAt: existingEntry.addedAt,
      ...(payload.type === 'black' ? { scope: payload.scope || existingEntry.scope || 'global', guildId: (payload.scope || existingEntry.scope || 'global') === 'server' ? (payload.guildId || '') : '' } : {}),
    });
    await oldModel.deleteOne({ _id: existingEntry._id });
  } else {
    const updateFields = {};
    if (payload.reason && payload.reason !== existingEntry.reason) updateFields.reason = payload.reason;
    if (payload.raid && payload.raid !== existingEntry.raid) updateFields.raid = payload.raid;
    if (payload.logsUrl && payload.logsUrl !== existingEntry.logsUrl) updateFields.logsUrl = payload.logsUrl;
    // Image update is atomic across all 3 fields: if a new rehosted
    // image was provided, replace all 3; if a new legacy URL only,
    // replace all 3 to clear stale rehost refs; otherwise leave alone.
    if (payload.imageMessageId && payload.imageMessageId !== existingEntry.imageMessageId) {
      updateFields.imageUrl = '';
      updateFields.imageMessageId = payload.imageMessageId;
      updateFields.imageChannelId = payload.imageChannelId || '';
    } else if (payload.imageUrl && !payload.imageMessageId && payload.imageUrl !== existingEntry.imageUrl) {
      updateFields.imageUrl = payload.imageUrl;
      updateFields.imageMessageId = '';
      updateFields.imageChannelId = '';
    }
    // Scope change in place — only blacklist supports it. Approval flow
    // only reaches this branch when payload.type === existingEntry's
    // current type (no cross-list move), so checking type === 'black'
    // is enough.
    if (
      payload.type === 'black'
      && payload.scope
      && payload.scope !== (existingEntry.scope || 'global')
    ) {
      updateFields.scope = payload.scope;
      updateFields.guildId = payload.scope === 'server' ? (payload.guildId || '') : '';
    }
    if (Object.keys(updateFields).length > 0) {
      try {
        await oldModel.updateOne({ _id: existingEntry._id }, { $set: updateFields });
      } catch (err) {
        // Defense in depth for the unique index race on scope change
        if (err.code === 11000 && updateFields.scope) {
          await PendingApproval.deleteOne({ requestId });
          await interaction.editReply({
            content: '',
            embeds: [buildAlertEmbed({
              severity: AlertSeverity.WARNING,
              title: 'Scope Change Raced',
              description: 'Another entry with this name claimed the target scope between approval and persist. Approval aborted.',
              footer: 'Resubmit the edit, or remove the conflicting entry first.',
            })],
            components: [buildApprovalResultRow('Failed')],
          });
          return;
        }
        throw err;
      }
    }
    // Capture for the rich success embed below — virtual post-edit
    // entry is the pre-edit snapshot merged with updateFields.
    postEditEntry = { ...(existingEntry.toObject?.() || existingEntry), ...updateFields };
  }

  // Broadcast edit: routing decided by the FINAL scope (after any scope
  // change applied above). Using payload.scope first ensures that a
  // demote-to-local edit broadcasts only to owner, and a promote-to-global
  // edit broadcasts to all opted-in servers.
  const broadcastScope = payload.scope || existingEntry.scope || 'global';
  broadcastListChange('edited', { ...existingEntry.toObject?.() || existingEntry, reason: payload.reason || existingEntry.reason, raid: payload.raid || existingEntry.raid, scope: broadcastScope }, {
    type: payload.type,
    guildId: payload.guildId,
    requestedByDisplayName: payload.requestedByDisplayName,
    requestedByTag: payload.requestedByTag,
  }, { onlyOwner: broadcastScope === 'server' }).catch(() => {});

  await PendingApproval.deleteOne({ requestId });

  // Derive changes summary by comparing payload to the pre-edit snapshot.
  // The original /la-list edit command's `changes` array doesn't survive
  // the PendingApproval round trip, so we reconstruct it here for the
  // rich success embed.
  const approvalChanges = [];
  if (payload.reason && payload.reason !== existingEntry.reason) {
    approvalChanges.push(`Reason: "${existingEntry.reason || ''}" → "${payload.reason}"`);
  }
  if (isTypeChange) {
    const oldLabel = getListContext(payload.currentType).label;
    approvalChanges.push(`List: ${oldLabel} → ${newLabel}`);
  }
  if (payload.raid && payload.raid !== existingEntry.raid) {
    approvalChanges.push(`Raid: "${existingEntry.raid || 'N/A'}" → "${payload.raid}"`);
  }
  if (payload.logsUrl && payload.logsUrl !== (existingEntry.logsUrl || '')) {
    approvalChanges.push('Logs: updated');
  }
  const evidenceChanged =
    (payload.imageMessageId && payload.imageMessageId !== existingEntry.imageMessageId)
    || (payload.imageUrl && !payload.imageMessageId && payload.imageUrl !== existingEntry.imageUrl);
  if (evidenceChanged) {
    approvalChanges.push('Evidence: updated');
  }
  if (
    payload.type === 'black'
    && payload.scope
    && payload.scope !== (existingEntry.scope || 'global')
  ) {
    approvalChanges.push(`Scope: ${existingEntry.scope || 'global'} → ${payload.scope}`);
  }

  // Build the rich success embed for the requester reply. Falls back
  // to plain text if postEditEntry is somehow null (shouldn't happen
  // but defensive — null embeds[] is handled by notifyRequester).
  let approvalSuccessEmbed = null;
  if (postEditEntry) {
    const entryForEmbed = postEditEntry.toObject?.() || postEditEntry;
    const approvalFreshUrl = await resolveDisplayImageUrl(entryForEmbed, client);
    approvalSuccessEmbed = buildListEditSuccessEmbed(entryForEmbed, {
      changes: approvalChanges,
      type: payload.type,
      freshDisplayUrl: approvalFreshUrl,
      requesterDisplayName: payload.requestedByDisplayName || payload.requestedByTag || 'Unknown',
      isMove: isTypeChange,
    });
  }

  const editResult = {
    ok: true,
    content: `✅ Edit approved: **${existingEntry.name}**${isTypeChange ? ` moved to ${newLabel}` : ' updated'}.`,
    embeds: approvalSuccessEmbed ? [approvalSuccessEmbed] : [],
  };

  await interaction.editReply({
    content: `✅ Edit approved by **${interaction.user.tag}**.`,
    components: [buildApprovalResultRow('Approved')],
  });
  await syncApproverDmMessages(payload, {
    content: `✅ Edit approved by **${interaction.user.tag}**.`,
    components: [buildApprovalResultRow('Approved')],
  }, { excludeMessageId: interaction.message.id });
  await notifyRequesterAboutDecision(payload, editResult, false);
  return;
}
