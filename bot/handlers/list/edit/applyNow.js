/**
 * handlers/list/edit/applyNow.js
 * Auto-apply branch of /la-list edit · taken when the requester is an
 * officer (or otherwise auto-approver). Writes the edited entry to
 * the DB, preserves enrichmentSource + enrichedAt metadata across
 * cross-list moves so a future stale-loop doesn't treat the entry as
 * legacy null, then broadcasts the change.
 */

import {
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { editAlert, editEmbed } from '../../../utils/interactionReplies.js';
import {
  getListContext,
  buildListEditSuccessEmbed,
} from '../helpers.js';

/**
 * Apply a list-edit immediately (officer auto-approve path).
 * @param {object} args - the edit-flow context bag
 * @param {import('discord.js').Interaction} args.interaction
 * @param {import('discord.js').Client} args.client
 * @param {Function} args.broadcastListChange - guild broadcast
 * @param {object} args.existing - the Mongoose entry being edited
 * @param {string} args.currentType - blacklist | whitelist | watchlist
 * @param {string} args.targetType - the destination list type (same as
 *   currentType for in-place edit, different for cross-list move)
 *   · plus the rewritten payload fields (reason, raid, scope, image,
 *   allCharacters, …) and the updater identity.
 * @returns {Promise<void>}
 */
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
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Move Blocked',
          description: `**${existing.name}** already exists in ${newLabel}.`,
          footer: 'Remove the conflicting target entry first, then retry the move.',
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

      // Enrichment metadata carry-over rule: if this move appended any
      // manual additional_names, the merged allCharacters is no longer
      // a pure bible snapshot, so tag the resulting doc as 'manual' and
      // stamp now(). Otherwise preserve the source/timestamp from the
      // pre-move entry (null for legacy docs without metadata).
      const moveEnrichmentSource = additionalNamesParsed.added.length > 0
        ? 'manual'
        : (existing.enrichmentSource ?? null);
      const moveEnrichedAt = additionalNamesParsed.added.length > 0
        ? new Date()
        : (existing.enrichedAt ?? null);
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
        enrichmentSource: moveEnrichmentSource,
        enrichedAt: moveEnrichedAt,
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

      await editEmbed(
        interaction,
        buildListEditSuccessEmbed(movedEntry.toObject?.() || movedEntry, {
          changes,
          type: targetType,
          freshDisplayUrl: moveFreshUrl,
          requesterDisplayName: getInteractionDisplayName(interaction),
          isMove: true,
        }),
        { content: null }
      );
    } else {
      // Update in place
      const updateFields = {};
      if (newReason) updateFields.reason = newReason;
      if (newRaid) updateFields.raid = newRaid;
      if (newLogs) updateFields.logsUrl = newLogs;
      if (newImageUrl) {
        // New image provided · use rehost result if successful, else legacy URL
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
      // Scope change in place · only blacklist supports this. Atomic update
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
        // Manual append downgrades enrichmentSource to 'manual' and refreshes
        // the timestamp; the alt list is no longer a pure bible snapshot.
        updateOps.$set.enrichmentSource = 'manual';
        updateOps.$set.enrichedAt = new Date();
      }
      try {
        await model.updateOne({ _id: existing._id }, updateOps);
      } catch (err) {
        // Defense in depth: catch race-condition E11000 from the unique
        // index even though preflight should have caught it. Mongoose
        // wraps the duplicate-key error with code 11000.
        if (err.code === 11000 && isScopeChange) {
          await editAlert(interaction, {
            severity: AlertSeverity.WARNING,
            title: 'Scope Change Raced',
            description: 'Another entry with this name claimed the target scope between the preflight check and the persist step.',
            footer: 'Retry the command, or remove the conflicting entry first.',
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

      await editEmbed(
        interaction,
        buildListEditSuccessEmbed(editedEntry, {
          changes,
          type: currentType,
          freshDisplayUrl: editFreshUrl,
          requesterDisplayName: getInteractionDisplayName(interaction),
          isMove: false,
        }),
        { content: null }
      );
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
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      title: 'Edit Failed',
      description: 'Could not apply the edit.',
      fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
    });
  }
}
