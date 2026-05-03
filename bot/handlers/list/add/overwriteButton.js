import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import { buildRosterCharacters } from '../../../services/rosterService.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  getListContext,
  buildApprovalResultRow,
} from '../helpers.js';

export function createListAddOverwriteButtonHandler({
  syncApproverDmMessages,
  broadcastListChange,
  notifyRequesterAboutDecision,
}) {
  async function handleListAddOverwriteButton(interaction) {
    const [, requestId] = interaction.customId.split(':');
    const isOverwrite = interaction.customId.startsWith('listadd_overwrite:');

    await connectDB();
    const payload = await PendingApproval.findOneAndDelete({ requestId }).lean();

    if (!payload) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Request Expired',
          description: 'This approval request was already processed or has expired.',
        })],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    if (!isOverwrite) {
      // Keep existing · just clean up
      await interaction.editReply({
        content: `✅ Kept existing entry. New request for **${payload.name}** discarded.`,
        embeds: [],
        components: [buildApprovalResultRow('Kept Existing')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `✅ Kept existing entry. New request for **${payload.name}** discarded.`,
          embeds: [],
          components: [buildApprovalResultRow('Kept Existing')],
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
        await interaction.editReply({
          content: '',
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Original Entry Missing',
            description: 'The duplicate entry no longer exists - it may have been removed in a parallel session.',
            footer: 'Re-run /la-list add to create a fresh entry.',
          })],
          components: [buildApprovalResultRow('Failed')],
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
      await interaction.editReply({
        content: resultMsg,
        embeds: [],
        components: [buildApprovalResultRow('Overwritten')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: resultMsg,
          embeds: [],
          components: [buildApprovalResultRow('Overwritten')],
        },
        { excludeMessageId: interaction.message.id }
      );

      // Broadcast overwrite: global to all, server-scoped to owner only
      broadcastListChange('edited', dupeEntry, {
        type: payload.type,
        guildId: payload.guildId,
        requestedByDisplayName: payload.requestedByDisplayName,
        requestedByTag: payload.requestedByTag,
      }, { onlyOwner: dupeEntry.scope === 'server' }).catch(() => {});

      await notifyRequesterAboutDecision(payload, { ok: true, content: resultMsg }, false);
    } catch (err) {
      console.error('[list] Overwrite failed:', err.message);
      await interaction.editReply({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Overwrite Failed',
          description: 'Could not overwrite the existing entry.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
        components: [buildApprovalResultRow('Failed')],
      });
    }
  }

  return handleListAddOverwriteButton;
}
