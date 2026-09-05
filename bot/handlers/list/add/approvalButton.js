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

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { buildAlertEmbed, buildNoticeEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferUpdate, replyAlert } from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  buildApprovalResultRow,
  buildApprovalProcessingRow,
} from '../helpers.js';
import {
  PENDING_APPROVAL_ACCESS,
  resolvePendingApprovalAccess,
} from '../services/pendingApprovalAccess.js';
import { handleApprovedEditRequest } from './editApproval.js';
import { createApprovalMessageUpdater } from '../services/approvals.js';
import { buildDuplicateApprovalEmbed } from '../duplicate-ui.js';

/**
 * Build the Approve / Reject / Edit button handler for /la-list add.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 * @param {Function} deps.syncApproverDmMessages - fan-out updates to
 *   every approver DM so the same decision view stays in sync
 * @param {Function} deps.executeListAddToDatabase - shared add executor
 * @param {Function} deps.broadcastListChange - guild-broadcast notifier
 * @param {Function} deps.notifyRequesterAboutDecision - notify the origin channel
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
    const approvalAccess = await resolvePendingApprovalAccess({
      PendingApprovalModel: PendingApproval,
      requestId,
      approverId: interaction.user.id,
    });
    const { payload } = approvalAccess;

    if (!payload) {
      const notAuthorized =
        approvalAccess.status === PENDING_APPROVAL_ACCESS.notAuthorized;
      await replyAlert(interaction, {
        severity: notAuthorized ? AlertSeverity.ERROR : AlertSeverity.WARNING,
        ...t(`dialogue.approval.flow.${notAuthorized ? 'notAuthorized' : 'expired'}`, lang),
        lang,
      });
      return;
    }

    const isApproveAction = action === 'listadd_approve';
    const updateApprovers = createApprovalMessageUpdater({
      interaction, payload, lang, syncApproverDmMessages,
    });

    // Acknowledge immediately, then show processing state to avoid 3s timeout issues.
    await deferUpdate(interaction);

    const buildProcessingPayload = (targetLang) => ({
      content: null,
      embeds: [buildNoticeEmbed(
        t(`dialogue.approval.flow.${isApproveAction ? 'processingApprove' : 'processingReject'}`, targetLang, { user: interaction.user.tag }),
        { severity: AlertSeverity.INFO, titleIcon: '⏳', lang: targetLang }
      )],
      components: [buildApprovalProcessingRow(action, targetLang)],
    });
    await updateApprovers(buildProcessingPayload);

    if (!isApproveAction) {
      await PendingApproval.deleteOne({ requestId });

      const buildRejectedPayload = (targetLang) => ({
        content: null,
        embeds: [buildNoticeEmbed(
          t('dialogue.approval.flow.rejectedBy', targetLang, { user: interaction.user.tag }),
          { severity: AlertSeverity.ERROR, titleIcon: '✖️', lang: targetLang }
        )],
        components: [buildApprovalResultRow('Rejected', targetLang)],
      });
      await updateApprovers(buildRejectedPayload);

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
        // Keep the matched ID for the scope-preserving in-place overwrite.
        await PendingApproval.updateOne(
          { requestId },
          { $set: { duplicateEntryId: String(existing._id) } }
        );

        const buildDuplicatePayload = (targetLang) => {
          const overwriteRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`listadd_overwrite:${requestId}`).setLabel(t('common.actions.overwrite', targetLang)).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`listadd_keep:${requestId}`).setLabel(t('common.actions.keepExisting', targetLang)).setStyle(ButtonStyle.Secondary),
          );
          return {
            content: null,
            embeds: [buildDuplicateApprovalEmbed(existing, payload, targetLang)],
            components: [overwriteRow],
          };
        };

        await updateApprovers(buildDuplicatePayload);
        // Don't delete PendingApproval · needed for overwrite flow
        return;
      }

      // Success or non-duplicate error · clean up
      await PendingApproval.deleteOne({ requestId });

      const buildCompletedPayload = (targetLang) => ({
        content: null,
        embeds: [buildNoticeEmbed(
          t(`dialogue.approval.flow.${result.ok ? 'approvedSuccess' : 'approvedReturned'}`, targetLang, {
            user: interaction.user.tag,
            result: result.content,
          }),
          {
            severity: result.ok ? AlertSeverity.SUCCESS : AlertSeverity.WARNING,
            lang: targetLang,
          }
        )],
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed', targetLang)],
      });
      await updateApprovers(buildCompletedPayload);

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

      await updateApprovers(buildFailurePayload);

      await notifyRequesterAboutDecision(
        payload,
        { ok: false },
        false
      );
    }
  }

  return handleListAddApprovalButton;
}
