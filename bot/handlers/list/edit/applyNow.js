import {
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  getListContext,
  buildListEditSuccessEmbed,
} from '../helpers.js';

export async function applyListEditNow({
  interaction,
  client,
  broadcastListChange,
  existing,
  currentType,
  targetType,
  isTypeChange,
  isScopeChange,
  targetScope,
  editGuildId,
  editGuildDefaultScope,
  newReason,
  newRaid,
  newLogs,
  newImageUrl,
  newImageRehost,
  newScope,
  additionalNamesParsed,
  changes,
  isOwner,
}) {
  // Apply edit immediately
  try {
    if (isTypeChange) {
      // Move to different list: preflight duplicate check, then delete old + create new
      const { model: oldModel } = getListContext(currentType);
      const { model: newModel, label: newLabel } = getListContext(targetType);

      // Preflight: scope-aware duplicate check on target list
      const nameMatch = { $or: [{ name: existing.name }, { allCharacters: existing.name }] };
      let preflightQuery;
      if (targetType === 'black') {
        // Blacklist: only check global + own server entries (same as /la-list add)
        preflightQuery = { $and: [nameMatch, { $or: [
          { scope: 'global' },
          { scope: { $exists: false } },
          { scope: 'server', guildId: editGuildId },
        ] }] };
      } else {
        preflightQuery = nameMatch;
      }
      const targetDupe = await newModel.findOne(preflightQuery)
        .collation({ locale: 'en', strength: 2 }).lean();
      if (targetDupe) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Move Blocked',
            description: `**${existing.name}** already exists in ${newLabel}.`,
            footer: 'Remove the conflicting target entry first, then retry the move.',
          })],
        });
        return;
      }

      // Safe to move: create first, then delete old (if create fails, old entry preserved)
      const existingObj = existing.toObject?.() || existing;
      // Image inheritance: if user provided a new image AND it was rehosted,
      // use the rehost refs; if new image but rehost failed, use legacy URL;
      // if no new image, carry over the existing entry's image fields.
      const moveImageFields = newImageUrl
        ? (newImageRehost
            ? { imageUrl: '', imageMessageId: newImageRehost.messageId, imageChannelId: newImageRehost.channelId }
            : { imageUrl: newImageUrl, imageMessageId: '', imageChannelId: '' })
        : { imageUrl: existing.imageUrl || '', imageMessageId: existing.imageMessageId || '', imageChannelId: existing.imageChannelId || '' };

      const movedEntry = await newModel.create({
        name: existing.name,
        reason: newReason || existing.reason,
        raid: newRaid || existing.raid,
        logsUrl: newLogs || existing.logsUrl,
        ...moveImageFields,
        allCharacters: [
          ...(existing.allCharacters || []),
          ...additionalNamesParsed.added,
        ],
        addedByUserId: existing.addedByUserId,
        addedByTag: existing.addedByTag,
        addedByDisplayName: existing.addedByDisplayName,
        addedAt: existing.addedAt,
        ...(targetType === 'black' ? (() => {
          // Resolve scope priority: explicit user option → existing entry's
          // scope → guild default. This lets type-change + scope-change
          // happen in one command.
          const moveScope = newScope || existingObj.scope || editGuildDefaultScope;
          return { scope: moveScope, guildId: moveScope === 'server' ? editGuildId : '' };
        })() : {}),
      });
      await oldModel.deleteOne({ _id: existing._id });

      // Resolve the freshest evidence URL from the just-created entry so
      // the success embed renders the new image immediately (no broken
      // CDN snapshots, no extra round trip on re-render).
      const moveFreshUrl = await resolveDisplayImageUrl(movedEntry, client);

      await interaction.editReply({
        content: null,
        embeds: [
          buildListEditSuccessEmbed(movedEntry.toObject?.() || movedEntry, {
            changes,
            type: targetType,
            freshDisplayUrl: moveFreshUrl,
            requesterDisplayName: getInteractionDisplayName(interaction),
            isMove: true,
          }),
        ],
      });
    } else {
      // Update in place
      const updateFields = {};
      if (newReason) updateFields.reason = newReason;
      if (newRaid) updateFields.raid = newRaid;
      if (newLogs) updateFields.logsUrl = newLogs;
      if (newImageUrl) {
        // New image provided — use rehost result if successful, else legacy URL
        if (newImageRehost) {
          updateFields.imageUrl = '';
          updateFields.imageMessageId = newImageRehost.messageId;
          updateFields.imageChannelId = newImageRehost.channelId;
        } else {
          updateFields.imageUrl = newImageUrl;
          updateFields.imageMessageId = '';
          updateFields.imageChannelId = '';
        }
      }
      // Scope change in place — only blacklist supports this. Atomic update
      // of {scope, guildId} so the unique index sees the new combination.
      if (isScopeChange) {
        updateFields.scope = targetScope;
        updateFields.guildId = targetScope === 'server' ? editGuildId : '';
      }

      const { model } = getListContext(currentType);
      const updateOps = { $set: updateFields };
      if (additionalNamesParsed.added.length > 0) {
        updateOps.$addToSet = {
          allCharacters: { $each: additionalNamesParsed.added },
        };
      }
      try {
        await model.updateOne({ _id: existing._id }, updateOps);
      } catch (err) {
        // Defense in depth: catch race-condition E11000 from the unique
        // index even though preflight should have caught it. Mongoose
        // wraps the duplicate-key error with code 11000.
        if (err.code === 11000 && isScopeChange) {
          await interaction.editReply({
            embeds: [buildAlertEmbed({
              severity: AlertSeverity.WARNING,
              title: 'Scope Change Raced',
              description: 'Another entry with this name claimed the target scope between the preflight check and the persist step.',
              footer: 'Retry the command, or remove the conflicting entry first.',
            })],
          });
          return;
        }
        throw err;
      }

      // Build a virtual post-edit entry by merging updateFields onto the
      // pre-edit snapshot. Avoids an extra round trip to fetch the updated
      // doc just for the success embed. allCharacters is merged separately
      // because the persisted update used $addToSet, not $set.
      const editedEntry = { ...(existing.toObject?.() || existing), ...updateFields };
      if (additionalNamesParsed.added.length > 0) {
        editedEntry.allCharacters = [
          ...(existing.allCharacters || []),
          ...additionalNamesParsed.added,
        ];
      }
      const editFreshUrl = await resolveDisplayImageUrl(editedEntry, client);

      await interaction.editReply({
        content: null,
        embeds: [
          buildListEditSuccessEmbed(editedEntry, {
            changes,
            type: currentType,
            freshDisplayUrl: editFreshUrl,
            requesterDisplayName: getInteractionDisplayName(interaction),
            isMove: false,
          }),
        ],
      });
    }

    // Broadcast routing decided by the FINAL scope (after any scope change).
    // Skip broadcast for server-scoped entries to avoid spamming other guilds.
    const entryObj = existing.toObject?.() || existing;
    const finalScope = targetType === 'black' ? targetScope : 'global';
    if (!isOwner && finalScope !== 'server') {
      broadcastListChange('edited', { ...entryObj, reason: newReason || existing.reason, raid: newRaid || existing.raid, scope: finalScope }, {
        type: targetType,
        guildId: interaction.guild.id,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        requestedByTag: interaction.user.tag,
      }).catch(() => {});
    }

  } catch (err) {
    await interaction.editReply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Edit Failed',
        description: 'Could not apply the edit.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      })],
    });
  }
}
