import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import { refreshImageUrl } from '../../../utils/imageRehost.js';
import { COLORS } from '../../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';

export function createListAddViewEvidenceButtonHandler({ client }) {
  async function handleListAddViewEvidenceButton(interaction) {
    const requestId = interaction.customId.split(':')[1];
    await connectDB();

    // Restrict to assigned approvers only — same permission model as
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

    const evidenceEmbed = new EmbedBuilder()
      .setTitle(`📎 Evidence — ${payload.name}`)
      .setDescription(payload.reason ? `*${payload.reason}*` : null)
      .setImage(freshUrl)
      .setColor(payload.type === 'black' ? COLORS.danger : payload.type === 'white' ? COLORS.success : COLORS.warning)
      .setFooter({
        text: isLegacy
          ? 'Legacy image (may have expired) — submitted before evidence rehost'
          : 'Fresh URL just resolved from evidence channel',
      })
      .setTimestamp(payload.createdAt ? new Date(payload.createdAt) : new Date());

    await interaction.reply({
      embeds: [evidenceEmbed],
      ephemeral: true,
    });
  }

  return handleListAddViewEvidenceButton;
}
