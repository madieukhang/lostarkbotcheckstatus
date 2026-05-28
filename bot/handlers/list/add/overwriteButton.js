/**
 * handlers/list/add/overwriteButton.js
 * "Overwrite" + "Keep existing" buttons on the duplicate-detection
 * branch of /la-list add. When the requester is adding a name that
 * already exists on another list (or same list with different reason),
 * the approval card offers an overwrite path · this handler refreshes
 * allCharacters via a fresh bible scrape, stamps the enrichment meta,
 * and rewrites the existing entry in place.
 */

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { buildRosterCharacters } from '../../../services/roster/index.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { editPayload, replyAlert } from '../../../utils/interactionReplies.js';
import { getUserLanguage } from '../../../services/i18n/index.js';
import {
  getListContext,
  buildApprovalResultRow,
} from '../helpers.js';

/**
 * Build the Overwrite / Keep-existing button handler for the duplicate
 * branch of /la-list add.
 * @param {object} deps
 * @param {Function} deps.syncApproverDmMessages - approver DM sync
 * @param {Function} deps.broadcastListChange - guild broadcast
 * @param {Function} deps.notifyRequesterAboutDecision - requester DM
 * @returns {Function} handleListAddOverwriteButton(interaction)
 */
export function createListAddOverwriteButtonHandler({
  syncApproverDmMessages,
  broadcastListChange,
  notifyRequesterAboutDecision,
}) {
  async function handleListAddOverwriteButton(interaction) {
    const [, requestId] = interaction.customId.split(':');
    const isOverwrite = interaction.customId.startsWith('listadd_overwrite:');

    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const payload = await PendingApproval.findOneAndDelete({ requestId }).lean();

    if (!payload) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Request Expired',
        description: 'This approval request was already processed or has expired.',
      });
      return;
    }

    await interaction.deferUpdate();

    if (!isOverwrite) {
      // Keep existing · just clean up
      await editPayload(interaction, {
        content: `✅ Kept existing entry. New request for **${payload.name}** discarded.`,
        embeds: [],
        components: [buildApprovalResultRow('Kept Existing', lang)],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `✅ Kept existing entry. New request for **${payload.name}** discarded.`,
          embeds: [],
          components: [buildApprovalResultRow('Kept Existing', lang)],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    // Overwrite: update existing entry in-place (safe · no delete-then-add risk)
    try {
      const { model } = getListContext(payload.type);

      // Find the duplicate entry to update
      let dupeEntry;
      if (payload.duplicateEntryId) {
        dupeEntry = await model.findById(payload.duplicateEntryId);
      }
      if (!dupeEntry) {
        // Fallback: scope-aware find
        const name = normalizeCharacterName(payload.name);
        const nameMatch = { $or: [{ name }, { allCharacters: name }] };
        if (payload.type === 'black') {
          const entryScope = payload.scope || 'global';
          const scopeMatch = entryScope === 'server'
            ? { scope: 'server', guildId: payload.guildId || '' }
            : { $or: [{ scope: 'global' }, { scope: { $exists: false } }] };
          dupeEntry = await model.findOne({ $and: [nameMatch, scopeMatch] }).collation({ locale: 'en', strength: 2 });
        } else {
          dupeEntry = await model.findOne(nameMatch).collation({ locale: 'en', strength: 2 });
        }
      }

      if (!dupeEntry) {
        await editPayload(interaction, {
          content: '',
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Original Entry Missing',
            description: 'The duplicate entry no longer exists - it may have been removed in a parallel session.',
            footer: 'Re-run /la-list add to create a fresh entry.',
          })],
          components: [buildApprovalResultRow('Failed', lang)],
        });
        return;
      }

      // Update in-place: overwrite fields + refresh roster for new canonical name
      const newName = normalizeCharacterName(payload.name);
      const rosterResult = await buildRosterCharacters(newName, {
        hiddenRosterFallback: true,
      }).catch(() => null);

      dupeEntry.name = newName;
      // Only update roster if fetch succeeded · preserve old snapshot on failure
      if (rosterResult?.hasValidRoster && rosterResult.allCharacters?.length > 0) {
        dupeEntry.allCharacters = rosterResult.allCharacters;
        // Refresh stamped the alt list from a bible scrape just now, so
        // record source + timestamp. Without this the stale-loop would
        // misread the entry as legacy/null even though it was just refreshed.
        dupeEntry.enrichmentSource = 'bible';
        dupeEntry.enrichedAt = new Date();
      }
      dupeEntry.reason = payload.reason || dupeEntry.reason;
      dupeEntry.raid = payload.raid || dupeEntry.raid;
      dupeEntry.logsUrl = payload.logsUrl || dupeEntry.logsUrl;
      // Image overwrite: prefer new rehost refs, fall back to new legacy URL,
      // else preserve existing entry's image fields entirely.
      if (payload.imageMessageId) {
        dupeEntry.imageUrl = '';
        dupeEntry.imageMessageId = payload.imageMessageId;
        dupeEntry.imageChannelId = payload.imageChannelId || '';
      } else if (payload.imageUrl) {
        dupeEntry.imageUrl = payload.imageUrl;
        dupeEntry.imageMessageId = '';
        dupeEntry.imageChannelId = '';
      }
      // Preserve existing scope · overwrite should not change global↔server
      // (scope is a structural property, not metadata)
      dupeEntry.addedByUserId = payload.requestedByUserId;
      dupeEntry.addedByTag = payload.requestedByTag;
      dupeEntry.addedByName = payload.requestedByName;
      dupeEntry.addedByDisplayName = payload.requestedByDisplayName;
      dupeEntry.addedAt = new Date();
      await dupeEntry.save();

      console.log(`[list] Overwrite: updated ${payload.type} entry for ${dupeEntry.name} in-place`);

      const resultMsg = `✅ Overwritten by **${interaction.user.tag}**. Entry updated.`;
      await editPayload(interaction, {
        content: resultMsg,
        embeds: [],
        components: [buildApprovalResultRow('Overwritten', lang)],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: resultMsg,
          embeds: [],
          components: [buildApprovalResultRow('Overwritten', lang)],
        },
        { excludeMessageId: interaction.message.id }
      );

      // Broadcast overwrite: global to all, server-scoped to owner only
      broadcastListChange('edited', dupeEntry, {
        type: payload.type,
        guildId: payload.guildId,
        requestedByDisplayName: payload.requestedByDisplayName,
        requestedByTag: payload.requestedByTag,
      }, {
        onlyOwner: dupeEntry.scope === 'server',
        rosterCharacters: rosterResult?.rosterCharacters || [],
      }).catch(() => {});

      await notifyRequesterAboutDecision(payload, { ok: true, content: resultMsg }, false);
    } catch (err) {
      console.error('[list] Overwrite failed:', err.message);
      await editPayload(interaction, {
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Overwrite Failed',
          description: 'Could not overwrite the existing entry.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
        components: [buildApprovalResultRow('Failed', lang)],
      });
    }
  }

  return handleListAddOverwriteButton;
}
