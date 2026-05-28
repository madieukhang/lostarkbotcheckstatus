/**
 * handlers/list/add/approvalButton.js
 * Handles the Approve / Reject / Edit buttons attached to a pending
 * /la-list add request (delivered to approvers via DM). Approve calls
 * executeListAddToDatabase and broadcasts, Reject closes the request,
 * Edit hands off to editApproval.js for a modal-based rewrite of
 * reason/raid/scope before approval.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { COLORS } from '../../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { editPayload, replyAlert } from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  getListContext,
  buildApprovalResultRow,
  buildApprovalProcessingRow,
} from '../helpers.js';
import { handleApprovedEditRequest } from './editApproval.js';

/**
 * Build the Approve / Reject / Edit button handler for /la-list add.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 * @param {Function} deps.syncApproverDmMessages - fan-out updates to
 *   every approver DM so the same decision view stays in sync
 * @param {Function} deps.executeListAddToDatabase - shared add executor
 * @param {Function} deps.broadcastListChange - guild-broadcast notifier
 * @param {Function} deps.notifyRequesterAboutDecision - DM the requester
 *   with the final outcome (approved / rejected / edited)
 * @returns {Function} handleListAddApprovalButton(interaction)
 */
export function createListAddApprovalButtonHandler({
  client,
  syncApproverDmMessages,
  executeListAddToDatabase,
  broadcastListChange,
  notifyRequesterAboutDecision,
}) {
  async function handleListAddApprovalButton(interaction) {
    const customParts = interaction.customId.split(':');
    const action = customParts[0];
    const requestId = customParts[1];
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    // Find but don't delete yet · need to keep for duplicate overwrite flow
    const payload = await PendingApproval.findOne({
      requestId,
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId });

      if (stillExists) {
        await replyAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: 'Not Authorised',
          description: 'You are not on the approver list for this request.',
        });
        return;
      }

      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Request Expired',
        description: 'This approval request was already processed or has expired.',
      });
      return;
    }

    const isApproveAction = action === 'listadd_approve';

    // Acknowledge immediately, then show processing state to avoid 3s timeout issues.
    await interaction.deferUpdate();

    await editPayload(interaction, {
      content: isApproveAction
        ? `⏳ Processing approval by **${interaction.user.tag}**...`
        : `⏳ Processing rejection by **${interaction.user.tag}**...`,
      components: [buildApprovalProcessingRow(action, lang)],
    });

    await syncApproverDmMessages(
      payload,
      {
        content: isApproveAction
          ? `⏳ Processing approval by **${interaction.user.tag}**...`
          : `⏳ Processing rejection by **${interaction.user.tag}**...`,
        components: [buildApprovalProcessingRow(action, lang)],
      },
      { excludeMessageId: interaction.message.id }
    );

    if (!isApproveAction) {
      await PendingApproval.deleteOne({ requestId });

      await editPayload(interaction, {
        content: `❌ Rejected by **${interaction.user.tag}**`,
        components: [buildApprovalResultRow('Rejected', lang)],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `❌ Rejected by **${interaction.user.tag}**`,
          components: [buildApprovalResultRow('Rejected', lang)],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    try {
      // Edit approval · update/move existing entry by _id (not add new)
      if (payload.action === 'edit' && payload.existingEntryId) {
        await handleApprovedEditRequest({
          client,
          interaction,
          payload,
          requestId,
          syncApproverDmMessages,
          broadcastListChange,
          notifyRequesterAboutDecision,
          lang,
        });
        return;
      }

      const result = await executeListAddToDatabase(payload);

      // Duplicate found · show comparison and overwrite option
      if (!result.ok && result.isDuplicate) {
        const existing = result.existingEntry;
        const { label } = getListContext(payload.type);

        // Save duplicate entry _id for scope-safe deletion during overwrite
        await PendingApproval.updateOne(
          { requestId },
          { $set: { duplicateEntryId: String(existing._id) } }
        );

        const existingScopeTag = existing.scope === 'server' ? ' [Server]' : ' [Global]';
        const requestScopeTag = payload.scope === 'server' ? ' [Server]' : ' [Global]';
        const compareEmbed = new EmbedBuilder()
          .setTitle('⚠️ Duplicate Found · Compare')
          .addFields(
            { name: `📌 Existing Entry${existingScopeTag}`, value: `**${existing.name}**\nReason: ${existing.reason || 'N/A'}\nRaid: ${existing.raid || 'N/A'}\nAdded: <t:${Math.floor(new Date(existing.addedAt || 0).getTime() / 1000)}:R>`, inline: true },
            { name: `🆕 New Request${requestScopeTag}`, value: `**${payload.name}**\nReason: ${payload.reason || 'N/A'}\nRaid: ${payload.raid || 'N/A'}\nBy: ${payload.requestedByDisplayName || 'Unknown'}`, inline: true },
          )
          .setColor(COLORS.warning);

        const overwriteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`listadd_overwrite:${requestId}`)
            .setLabel(t('common.actions.overwrite', lang))
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`listadd_keep:${requestId}`)
            .setLabel(t('common.actions.keepExisting', lang))
            .setStyle(ButtonStyle.Secondary),
        );

        await editPayload(interaction, {
          content: `⚠️ **${payload.name}** already in ${label}. Overwrite or keep?`,
          embeds: [compareEmbed],
          components: [overwriteRow],
        });

        await syncApproverDmMessages(
          payload,
          {
            content: `⚠️ **${payload.name}** already in ${label}. Overwrite or keep?`,
            embeds: [compareEmbed],
            components: [overwriteRow],
          },
          { excludeMessageId: interaction.message.id }
        );
        // Don't delete PendingApproval · needed for overwrite flow
        return;
      }

      // Success or non-duplicate error · clean up
      await PendingApproval.deleteOne({ requestId });

      await editPayload(interaction, {
        content: result.ok
          ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
          : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed', lang)],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: result.ok
            ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
            : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
          components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed', lang)],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, result, false);
    } catch (err) {
      await PendingApproval.deleteOne({ requestId });

      const failureEmbed = buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Approval Execution Failed',
        description: `Approval was confirmed by **${interaction.user.tag}** but the executor threw.`,
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      });

      await editPayload(interaction, {
        content: '',
        embeds: [failureEmbed],
        components: [buildApprovalResultRow('Failed', lang)],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: '',
          embeds: [failureEmbed],
          components: [buildApprovalResultRow('Failed', lang)],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(
        payload,
        {
          content: `Approval ran but the executor threw: \`${err.message}\``,
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Approval Execution Failed',
            description: 'The senior approved your request, but persisting it threw.',
            fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
            footer: 'No entry was created. Try resubmitting, or contact a senior.',
          })],
        },
        false
      );
    }
  }

  return handleListAddApprovalButton;
}
