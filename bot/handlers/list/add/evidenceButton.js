/**
 * handlers/list/add/evidenceButton.js
 * "View evidence" button on the approval-DM card · re-renders the
 * approval request's image + reason via the same buildEvidenceEmbed
 * used by /la-evidence, /la-search, /la-list view. Approver-gated so
 * non-approvers can't fetch evidence images via a leaked button id.
 */

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { refreshImageUrl } from '../../../utils/imageRehost.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferEphemeralReply, editAlert, editEmbed } from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { buildEvidenceEmbed } from '../view/ui.js';
import { decorateListEntry } from '../helpers.js';

/**
 * Build the "View evidence" button handler attached to approval DM cards.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   (used to refresh the rehosted evidence image URL if it's expired)
 * @returns {Function} handleListAddViewEvidenceButton(interaction)
 */
export function createListAddViewEvidenceButtonHandler({ client }) {
  async function handleListAddViewEvidenceButton(interaction) {
    const requestId = interaction.customId.split(':')[1];
    await deferEphemeralReply(interaction);
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    // Restrict to assigned approvers only · same permission model as
    // Approve/Reject. Avoids leaking evidence images to non-approvers who
    // somehow get hold of the button (shouldn't happen, but defense in depth).
    const payload = await PendingApproval.findOne({
      requestId,
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId });
      if (stillExists) {
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          ...t('dialogue.approval.flow.evidenceNotAuthorized', lang),
          lang,
        });
      } else {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          ...t('dialogue.approval.flow.expired', lang),
          lang,
        });
      }
      return;
    }

    // Resolve the freshest possible URL: rehost-aware first, legacy fallback.
    let freshUrl = null;
    let isLegacy = false;
    if (payload.imageMessageId && payload.imageChannelId) {
      freshUrl = await refreshImageUrl(payload.imageMessageId, payload.imageChannelId, client);
    }
    if (!freshUrl && payload.imageUrl) {
      freshUrl = payload.imageUrl;
      isLegacy = true;
    }

    if (!freshUrl) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.approval.flow.noEvidence', lang),
        lang,
      });
      return;
    }

    // Route through the shared buildEvidenceEmbed so the approval-flow
    // evidence card carries the same tokens (Reason field, list icon,
    // inline meta, Tracked alts) that /la-evidence, /la-search,
    // /la-list view, and /la-check already render. Approvers reviewing
    // evidence used to see a thinner card here than they would later
    // in /la-list view; this closes that gap.
    const decorated = {
      ...decorateListEntry(payload, payload.type),
      addedAt: payload.createdAt || payload.addedAt,
      addedByDisplayName: payload.requestedByDisplayName || payload.addedByDisplayName || '',
    };
    const evidenceEmbed = buildEvidenceEmbed(decorated, freshUrl, { includeAddedBy: true, lang });
    evidenceEmbed.setFooter({
      text: isLegacy
        ? t('dialogue.approval.flow.evidenceFooterLegacy', lang)
        : t('dialogue.approval.flow.evidenceFooterFresh', lang),
    });

    await editEmbed(interaction, evidenceEmbed);
  }

  return handleListAddViewEvidenceButton;
}
