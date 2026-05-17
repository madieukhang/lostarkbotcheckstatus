import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import { refreshImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { buildEvidenceEmbed } from '../view/ui.js';
import { getListContext } from '../helpers.js';

export function createListAddViewEvidenceButtonHandler({ client }) {
  async function handleListAddViewEvidenceButton(interaction) {
    const requestId = interaction.customId.split(':')[1];
    await connectDB();

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
        await interaction.reply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Not Authorised',
            description: 'You are not on the approver list for this request, so you cannot view its evidence.',
          })],
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Request Expired',
            description: 'This approval request was already processed or has expired.',
          })],
          ephemeral: true,
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
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'No Evidence Available',
          description: 'No evidence image attached to this request, or the rehosted message was removed.',
        })],
        ephemeral: true,
      });
      return;
    }

    // Route through the shared buildEvidenceEmbed so the approval-flow
    // evidence card carries the same tokens (Reason field, list icon,
    // inline meta, Tracked alts) that /la-evidence, /la-search,
    // /la-list view, and /la-check already render. Approvers reviewing
    // evidence used to see a thinner card here than they would later
    // in /la-list view; this closes that gap.
    const ctx = getListContext(payload.type);
    const decorated = {
      ...payload,
      _icon: ctx.icon,
      _label: ctx.label,
      _color: ctx.color,
      addedAt: payload.createdAt || payload.addedAt,
      addedByDisplayName: payload.requestedByDisplayName || payload.addedByDisplayName || '',
    };
    const evidenceEmbed = buildEvidenceEmbed(decorated, freshUrl, { includeAddedBy: true });
    evidenceEmbed.setFooter({
      text: isLegacy
        ? 'Legacy image (may have expired) · submitted before evidence rehost'
        : 'Fresh URL just resolved from evidence channel',
    });

    await interaction.reply({
      embeds: [evidenceEmbed],
      ephemeral: true,
    });
  }

  return handleListAddViewEvidenceButton;
}
