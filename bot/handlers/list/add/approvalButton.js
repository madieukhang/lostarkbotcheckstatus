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
} from 'discord.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { COLORS } from '../../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferUpdate, editPayload, replyAlert } from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
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
          ...t('dialogue.approval.flow.notAuthorized', lang),
          lang,
        });
        return;
      }

      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.approval.flow.expired', lang),
        lang,
      });
      return;
    }

    const isApproveAction = action === 'listadd_approve';

    // Acknowledge immediately, then show processing state to avoid 3s timeout issues.
    await deferUpdate(interaction);

    const buildProcessingPayload = (targetLang) => ({
      content: `⏳ ${t(`dialogue.approval.flow.${isApproveAction ? 'processingApprove' : 'processingReject'}`, targetLang, { user: interaction.user.tag })}`,
      components: [buildApprovalProcessingRow(action, lang)],
    });
    await editPayload(interaction, buildProcessingPayload(lang));

    await syncApproverDmMessages(
      payload,
      (targetLang) => ({
        ...buildProcessingPayload(targetLang),
        components: [buildApprovalProcessingRow(action, targetLang)],
      }),
      { excludeMessageId: interaction.message.id }
    );

    if (!isApproveAction) {
      await PendingApproval.deleteOne({ requestId });

      const buildRejectedPayload = (targetLang) => ({
        content: `❌ ${t('dialogue.approval.flow.rejectedBy', targetLang, { user: interaction.user.tag })}`,
        components: [buildApprovalResultRow('Rejected', lang)],
      });
      await editPayload(interaction, buildRejectedPayload(lang));

      await syncApproverDmMessages(
        payload,
        (targetLang) => ({
          ...buildRejectedPayload(targetLang),
          components: [buildApprovalResultRow('Rejected', targetLang)],
        }),
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
        // Save duplicate entry _id for scope-safe deletion during overwrite
        await PendingApproval.updateOne(
          { requestId },
          { $set: { duplicateEntryId: String(existing._id) } }
        );

        const buildDuplicatePayload = (targetLang) => {
          const scopeKey = (scope) => scope === 'server' ? 'local' : 'global';
          const scopeTag = (scope) => ` [${t(`dialogue.approval.scopeTag.${scopeKey(scope)}`, targetLang)}]`;
          const fallback = t('dialogue.broadcast.notAvailable', targetLang);
          const compareEmbed = createArtistEmbed(targetLang)
            .setTitle(`⚠️ ${t('dialogue.approval.flow.duplicateTitle', targetLang)}`)
            .addFields(
              {
                name: `📌 ${t('dialogue.approval.flow.existingEntry', targetLang)}${scopeTag(existing.scope)}`,
                value: `**${existing.name}**\n${t('dialogue.approval.flow.compareReason', targetLang)}: ${existing.reason || fallback}\n${t('dialogue.approval.flow.compareRaid', targetLang)}: ${existing.raid || fallback}\n${t('dialogue.approval.flow.compareAdded', targetLang)}: <t:${Math.floor(new Date(existing.addedAt || 0).getTime() / 1000)}:R>`,
                inline: true,
              },
              {
                name: `🆕 ${t('dialogue.approval.flow.newRequest', targetLang)}${scopeTag(payload.scope)}`,
                value: `**${payload.name}**\n${t('dialogue.approval.flow.compareReason', targetLang)}: ${payload.reason || fallback}\n${t('dialogue.approval.flow.compareRaid', targetLang)}: ${payload.raid || fallback}\n${t('dialogue.approval.flow.compareBy', targetLang)}: ${payload.requestedByDisplayName || t('dialogue.common.unknown', targetLang)}`,
                inline: true,
              },
            )
            .setColor(COLORS.warning);
          const overwriteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`listadd_overwrite:${requestId}`).setLabel(t('common.actions.overwrite', targetLang)).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`listadd_keep:${requestId}`).setLabel(t('common.actions.keepExisting', targetLang)).setStyle(ButtonStyle.Secondary),
          );
          return {
            content: `⚠️ ${t('dialogue.approval.flow.duplicatePrompt', targetLang, {
              name: payload.name,
              list: t(`dialogue.broadcast.list.${payload.type}`, targetLang),
            })}`,
            embeds: [compareEmbed],
            components: [overwriteRow],
          };
        };

        await editPayload(interaction, buildDuplicatePayload(lang));

        await syncApproverDmMessages(
          payload,
          buildDuplicatePayload,
          { excludeMessageId: interaction.message.id }
        );
        // Don't delete PendingApproval · needed for overwrite flow
        return;
      }

      // Success or non-duplicate error · clean up
      await PendingApproval.deleteOne({ requestId });

      const buildCompletedPayload = (targetLang) => ({
        content: `${result.ok ? '✅' : '⚠️'} ${t(`dialogue.approval.flow.${result.ok ? 'approvedSuccess' : 'approvedReturned'}`, targetLang, {
          user: interaction.user.tag,
          result: result.content,
        })}`,
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed', lang)],
      });
      await editPayload(interaction, buildCompletedPayload(lang));

      await syncApproverDmMessages(
        payload,
        (targetLang) => ({
          ...buildCompletedPayload(targetLang),
          components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed', targetLang)],
        }),
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, result, false);
    } catch (err) {
      await PendingApproval.deleteOne({ requestId });

      const buildFailurePayload = (targetLang) => ({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          ...t('dialogue.approval.flow.executionFailed', targetLang, { user: interaction.user.tag }),
          fields: [{ name: t('dialogue.common.errorField', targetLang), value: `\`${err.message}\``, inline: false }],
          lang: targetLang,
        })],
        components: [buildApprovalResultRow('Failed', targetLang)],
      });

      await editPayload(interaction, buildFailurePayload(lang));

      await syncApproverDmMessages(
        payload,
        buildFailurePayload,
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(
        payload,
        { ok: false },
        false
      );
    }
  }

  return handleListAddApprovalButton;
}
