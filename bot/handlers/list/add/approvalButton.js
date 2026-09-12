/**
 * handlers/list/add/approvalButton.js
 * Apply or reject pending add/edit requests using the shared approval lifecycle.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { buildAlertEmbed, buildNoticeEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { t } from '../../../services/i18n/index.js';
import {
  buildApprovalResultRow,
  buildApprovalRetryRow,
} from '../helpers.js';
import { createApprovalDecisionHandler, handleApprovalClaimError } from '../services/approvalInteraction.js';
import { handleApprovedEditRequest } from './editApproval.js';
import { createApprovalMessageUpdater } from '../services/approvals.js';
import { buildDuplicateApprovalEmbed } from '../duplicate-ui.js';

/**
 * Build the Approve / Reject handler for single add and edit requests.
 * @param {object} deps
 * @param {Function} deps.syncApproverDmMessages - fan-out updates to
 *   every approver DM so the same decision view stays in sync
 * @param {Function} deps.executeListAddToDatabase - shared add executor
 * @param {Function} deps.broadcastListChange - guild-broadcast notifier
 * @param {Function} deps.notifyRequesterAboutDecision - notify the origin channel
 *   with the final outcome (approved / rejected / edited)
 * @returns {Function} handleListAddApprovalButton(interaction)
 */
export function createListAddApprovalButtonHandler({
  syncApproverDmMessages,
  executeListAddToDatabase,
  broadcastListChange,
  notifyRequesterAboutDecision,
}) {
  return createApprovalDecisionHandler(async ({ interaction, action, requestId, lang, payload, claim }) => {
    const isApproveAction = action === 'listadd_approve';
    const updateApprovers = createApprovalMessageUpdater({
      interaction, payload, lang, syncApproverDmMessages,
    });

    const buildProcessingPayload = (targetLang) => ({
      content: null,
      embeds: [buildNoticeEmbed(
        t(`dialogue.approval.flow.${isApproveAction ? 'processingApprove' : 'processingReject'}`, targetLang, { user: interaction.user.tag }),
        { severity: AlertSeverity.INFO, titleIcon: '⏳', lang: targetLang }
      )],
      components: [buildApprovalRetryRow(action, requestId, targetLang)],
    });
    try {
      await updateApprovers(buildProcessingPayload);
    } catch (err) {
      // No decision has run yet. Keep the request retryable if rendering fails.
      await claim.release();
      throw err;
    }

    if (!isApproveAction) {
      await claim.complete();

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
          interaction,
          payload,
          requestId,
          syncApproverDmMessages,
          broadcastListChange,
          notifyRequesterAboutDecision,
          completeApproval: () => claim.complete(),
          beforeWrite: () => claim.assertOwned(),
          lang,
        });
        return;
      }

      const result = await executeListAddToDatabase(payload, { beforeWrite: () => claim.assertOwned() });

      // Duplicate found · show comparison and overwrite option
      if (!result.ok && result.isDuplicate) {
        const existing = result.existingEntry;
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
        // Publish the next controls while still holding the current decision;
        // only then release the request for the keep/overwrite phase.
        await claim.release({ duplicateEntryId: String(existing._id) }, { clearDecision: true });
        // Don't delete PendingApproval · needed for overwrite flow
        return;
      }

      // Success or non-duplicate error · clean up
      await claim.complete();

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
      if (await handleApprovalClaimError({ claim, interaction, error: err, lang, label: 'Decision' })) return;

      const buildFailurePayload = (targetLang) => ({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          ...t('dialogue.approval.flow.retryFailed', targetLang),
          fields: [{ name: t('dialogue.common.errorField', targetLang), value: `\`${err.message}\``, inline: false }],
          lang: targetLang,
        })],
        components: [buildApprovalRetryRow(action, requestId, targetLang)],
      });

      await updateApprovers(buildFailurePayload);

    }
  });
}
