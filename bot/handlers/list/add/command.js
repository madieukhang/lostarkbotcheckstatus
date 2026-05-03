import { randomUUID } from 'node:crypto';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import {
  normalizeCharacterName,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { getGuildConfig } from '../../../utils/scope.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  buildListAddApprovalEmbed,
  isRequesterAutoApprover,
} from '../helpers.js';

export function createListAddCommandHandler({
  client,
  sendListAddApprovalToApprovers,
  executeListAddToDatabase,
}) {
  async function handleListAddCommand(interaction) {
    const type = interaction.options.getString('type', true);
    const rawName = interaction.options.getString('name', true).trim();
    const reason = interaction.options.getString('reason', true).trim();
    const raid = interaction.options.getString('raid') ?? '';
    const logs = interaction.options.getString('logs') ?? '';
    const image = interaction.options.getAttachment('image');
    const inputScope = interaction.options.getString('scope') || '';
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    if (!interaction.guild) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Server-Only Command',
          description: 'This command can only be used inside a Discord server, not in DMs.',
        })],
      });
      return;
    }

    // Resolve scope: explicit input > guild default setting > 'global'
    let scope = inputScope;
    if (!scope && type === 'black') {
      await connectDB();
      const guildConfig = await getGuildConfig(interaction.guild.id);
      scope = guildConfig?.defaultBlacklistScope || 'global';
    }
    if (!scope) scope = 'global'; // non-blacklist types always global

    if (!reason) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Reason Required',
          description: 'Every list entry needs a reason. Re-run the command and fill the `reason` option.',
        })],
      });
      return;
    }

    if (image?.contentType && !image.contentType.startsWith('image/')) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Invalid Attachment',
          description: `The \`image\` option only accepts image files. Detected content type: \`${image.contentType}\`.`,
        })],
      });
      return;
    }

    try {
      const requestId = randomUUID();

      // Rehost the image NOW (while the Discord CDN URL is still valid).
      // If rehost fails or no evidence channel is configured, we fall back to
      // storing the original URL as legacy (which will eventually expire).
      let rehostResult = null;
      if (image?.url) {
        rehostResult = await rehostImage(image.url, client, {
          entryName: name,
          addedBy: getInteractionDisplayName(interaction),
          listType: type,
        });
      }

      const payload = {
        requestId,
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        logsUrl: logs,
        // imageUrl carries the CURRENT display URL (fresh at this moment).
        // If rehosted, use the freshly-signed evidence URL; otherwise the
        // original attachment URL. Either way it's valid for immediate render.
        // executeListAddToDatabase decides whether to PERSIST this URL based
        // on whether imageMessageId is set (rehosted entries don't store URL).
        imageUrl: rehostResult?.freshUrl || image?.url || '',
        imageMessageId: rehostResult?.messageId || '',
        imageChannelId: rehostResult?.channelId || '',
        scope: type === 'black' ? scope : 'global', // scope only applies to blacklist
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: getInteractionDisplayName(interaction),
        createdAt: Date.now(),
      };

      // Auto-approve: officers always, OR server-scoped entries (local = no approval needed)
      if (isRequesterAutoApprover(payload.requestedByUserId) || payload.scope === 'server') {
        const result = await executeListAddToDatabase(payload);
        // Prefer rich embed when available; fall back to plain content for
        // simple success messages that don't need a structured alert.
        const hasEmbed = (result.embeds?.length ?? 0) > 0;
        await interaction.editReply({
          content: hasEmbed ? null : result.content,
          embeds: result.embeds ?? [],
        });
        return;
      }

      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Approval Request Failed',
            description: `Could not deliver the approval request to approvers.`,
            fields: [{ name: 'Reason', value: sent.reason || 'unknown', inline: false }],
            footer: 'No entry was created. Try again or contact an officer directly.',
          })],
        });
        return;
      }

      await connectDB();
      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        embeds: [
          buildListAddApprovalEmbed(interaction.guild, payload, {
            title: 'List Add — Proposal Submitted',
            includeRequestedBy: false,
          }),
        ],
      });

      try {
        const requestReply = await interaction.fetchReply();
        await PendingApproval.updateOne(
          { requestId },
          { $set: { requestMessageId: requestReply.id } }
        );
      } catch (err) {
        console.warn('[list] Failed to capture request reply message ID:', err.message);
      }
    } catch (err) {
      console.error('[list] ❌ Proposal create/send failed:', err.message);
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Proposal Failed',
          description: 'Could not create the approval request.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
          footer: 'No entry was created. Retry the command; if the error persists, contact an officer.',
        })],
      });
    }
  }

  return handleListAddCommand;
}
