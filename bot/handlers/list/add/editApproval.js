/**
 * handlers/list/add/editApproval.js
 * Handles the "approve + edit" path off the approval-button flow: an
 * approver opens a modal, rewrites the request's reason/raid/scope,
 * and submits · this module rewrites the PendingApproval doc, runs
 * the same add-to-DB executor as a plain approve, syncs approver DM
 * messages, notifies the requester, and broadcasts the change.
 */

import PendingApproval from '../../../models/PendingApproval.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { editPayload } from '../../../utils/interactionReplies.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { t } from '../../../services/i18n/index.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildApprovalResultRow,
} from '../helpers.js';

/**
 * Process an approver's "edit then approve" submission for a pending
 * /la-list add request. Rewrites the PendingApproval payload, runs the
 * add executor, fans out the result to every approver DM, notifies the
 * requester, and broadcasts the change to the per-guild notify channel.
 *
 * @param {object} args
 * @param {import('discord.js').Client} args.client - Discord client
 * @param {import('discord.js').Interaction} args.interaction - the
 *   modal-submit interaction from the approver
 * @param {object} args.payload - the rewritten add payload (name,
 *   reason, raid, scope, image, allCharacters, …) replacing the doc's
 *   original payload
 * @param {string} args.requestId - PendingApproval document _id
 * @param {Function} args.syncApproverDmMessages - approver DM sync
 * @param {Function} args.broadcastListChange - guild broadcast
 * @param {Function} args.notifyRequesterAboutDecision - requester DM
 * @returns {Promise<void>}
 */
export async function handleApprovedEditRequest({
  interaction,
  payload,
  requestId,
  syncApproverDmMessages,
  broadcastListChange,
  notifyRequesterAboutDecision,
  lang = 'en',
}) {
  const { model: oldModel } = getListContext(payload.currentType || payload.type);
  const { model: newModel } = getListContext(payload.type);
  const isTypeChange = payload.currentType && payload.currentType !== payload.type;

  const existingEntry = await oldModel.findById(payload.existingEntryId);
  if (!existingEntry) {
    await PendingApproval.deleteOne({ requestId });
    await editPayload(interaction, {
      content: '',
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        ...t('dialogue.listEdit.originalMissing', lang),
        lang,
      })],
      components: [buildApprovalResultRow('Failed', lang)],
    });
    return;
  }

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
      await editPayload(interaction, {
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          ...t('dialogue.listEdit.moveBlocked', lang, { name: existingEntry.name }),
          lang,
        })],
        components: [buildApprovalResultRow('Failed', lang)],
      });
      return;
    }

    // Recheck trusted guard at approval time (status may have changed)
    {
      const trustedNow = await TrustedUser.findOne(buildNameRosterQuery([
        existingEntry.name,
        ...(existingEntry.allCharacters || []),
      ])).collation({ locale: 'en', strength: 2 }).lean();
      if (trustedNow) {
        await PendingApproval.deleteOne({ requestId });
        await editPayload(interaction, {
          content: '',
          embeds: [buildTrustedBlockEmbed(existingEntry.name, trustedNow.reason, { lang })],
          components: [buildApprovalResultRow('Blocked', lang)],
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

    // Create first, then delete old (safe order · if create fails, old preserved)
    await newModel.create({
      name: existingEntry.name,
      reason: payload.reason || existingEntry.reason,
      raid: payload.raid || existingEntry.raid,
      logsUrl: payload.logsUrl || existingEntry.logsUrl,
      imageUrl: moveImageUrl,
      imageMessageId: moveImageMessageId,
      imageChannelId: moveImageChannelId,
      allCharacters: existingEntry.allCharacters || [],
      // Cross-list move via approval just copies the alt list verbatim, so
      // preserve the source/timestamp from the pre-move entry. Stale-loop
      // logic would otherwise see this freshly-created doc as legacy null
      // even though the alts haven't changed.
      enrichmentSource: existingEntry.enrichmentSource ?? null,
      enrichedAt: existingEntry.enrichedAt ?? null,
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
    // Scope change in place · only blacklist supports it. Approval flow
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
          await editPayload(interaction, {
            content: '',
            embeds: [buildAlertEmbed({
              severity: AlertSeverity.WARNING,
              ...t('dialogue.listEdit.scopeRaced', lang),
              lang,
            })],
            components: [buildApprovalResultRow('Failed', lang)],
          });
          return;
        }
        throw err;
      }
    }
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

  const buildApprovedPayload = (targetLang) => ({
    content: `✅ ${t('dialogue.listEdit.approvedBy', targetLang, { user: interaction.user.tag })}`,
    components: [buildApprovalResultRow('Approved', lang)],
  });
  await editPayload(interaction, buildApprovedPayload(lang));
  await syncApproverDmMessages(payload, (targetLang) => ({
    ...buildApprovedPayload(targetLang),
    components: [buildApprovalResultRow('Approved', targetLang)],
  }), { excludeMessageId: interaction.message.id });
  await notifyRequesterAboutDecision(payload, { ok: true }, false);
  return;
}
