import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { COLORS } from '../../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  getSeniorApproverIds,
  isOfficerOrSenior,
} from '../helpers.js';

export function createMultiaddConfirmButtonHandler(deps) {
  const {
    client,
    multiaddPending,
    clearMultiaddPending,
    sendBulkApprovalToApprovers,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = deps;

  return async function handleMultiaddConfirmButton(interaction) {
    const [prefix, requestId] = interaction.customId.split(':');
    const pending = multiaddPending.get(requestId);

    if (!pending) {
      await interaction.update({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Request Expired',
          description: 'This bulk-add preview has expired or was already processed.',
          footer: 'Re-upload the file with /la-list multiadd action:file to start over.',
        })],
        components: [],
      });
      return;
    }

    if (interaction.user.id !== pending.requesterId) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Not Your Request',
          description: 'Only the original uploader can use these buttons.',
        })],
        ephemeral: true,
      });
      return;
    }

    if (prefix === 'multiadd_cancel') {
      clearMultiaddPending(requestId);
      await interaction.update({
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.INFO,
          titleIcon: '✖️',
          title: 'Bulk Add Cancelled',
          description: 'No entries were added.',
        })],
        components: [],
      });
      return;
    }

    if (prefix !== 'multiadd_confirm') return;

    clearMultiaddPending(requestId);

    if (isOfficerOrSenior(pending.requesterId)) {
      await interaction.update({
        content: `⏳ Processing ${pending.rows.length} rows... (this may take up to ${Math.ceil(pending.rows.length * 0.7)}s)`,
        embeds: [],
        components: [],
      });

      const onProgress = async (current, total) => {
        if (current % 5 !== 0 && current !== total) return;
        try {
          await interaction.editReply({
            content: `⏳ Processing... ${current}/${total} rows done`,
          });
        } catch { /* ignore progress errors */ }
      };

      const meta = {
        guildId: pending.guildId,
        channelId: pending.channelId,
        requesterId: pending.requesterId,
        requesterTag: pending.requesterTag,
        requesterName: pending.requesterName,
        requesterDisplayName: pending.requesterDisplayName,
      };

      const results = await executeBulkMultiadd(pending.rows, meta, onProgress);

      broadcastBulkAdd(results.added, {
        guildId: pending.guildId,
        requestedByDisplayName: pending.requesterDisplayName,
      }).catch((err) => console.warn('[multiadd] Bulk broadcast failed:', err.message));

      const summaryEmbed = buildBulkSummaryEmbed(results, pending);
      await interaction.editReply({
        content: null,
        embeds: [summaryEmbed],
        components: [],
      });
      return;
    }

    try {
      await connectDB();

      const targetApproverIds = getSeniorApproverIds();
      if (targetApproverIds.length === 0) {
        await interaction.update({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Approval Routing Misconfigured',
            description: 'No Senior approver user IDs are configured.',
            footer: 'Set SENIOR_APPROVER_IDS in the bot env, then retry the upload.',
          })],
          embeds: [],
          components: [],
        });
        return;
      }

      const guild = interaction.guild || (await client.guilds.fetch(pending.guildId).catch(() => null));
      const rehostedRows = [];
      for (let i = 0; i < pending.rows.length; i++) {
        const row = pending.rows[i];
        let rehost = null;
        if (row.image) {
          rehost = await rehostImage(row.image, client, {
            entryName: row.name,
            addedBy: pending.requesterDisplayName || pending.requesterTag,
            listType: row.type,
          });
        }
        rehostedRows.push({
          ...row,
          _rehost: rehost,
        });
        if (i < pending.rows.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }

      const bulkRows = rehostedRows.map((row) => ({
        name: row.name,
        type: row.type,
        reason: row.reason,
        raid: row.raid || '',
        logsUrl: row.logs || '',
        imageUrl: row._rehost?.freshUrl || row.image || '',
        imageMessageId: row._rehost?.messageId || '',
        imageChannelId: row._rehost?.channelId || '',
        scope: row.scope || '',
      }));

      await PendingApproval.create({
        requestId,
        guildId: pending.guildId,
        channelId: pending.channelId,
        action: 'bulk',
        bulkRows,
        requestedByUserId: pending.requesterId,
        requestedByTag: pending.requesterTag,
        requestedByName: pending.requesterName || '',
        requestedByDisplayName: pending.requesterDisplayName,
        approverIds: targetApproverIds,
        approverDmMessages: [],
      });

      const approvalPending = {
        requestId,
        rows: pending.rows,
        requesterId: pending.requesterId,
        requesterTag: pending.requesterTag,
        requesterDisplayName: pending.requesterDisplayName,
        guildId: pending.guildId,
      };

      const sent = await sendBulkApprovalToApprovers(guild, approvalPending);

      if (!sent.success) {
        await PendingApproval.deleteOne({ requestId }).catch((err) =>
          console.warn('[multiadd] Failed to clean up placeholder approval:', err.message)
        );
        await interaction.update({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Approval Delivery Failed',
            description: 'Could not deliver the bulk-approval request.',
            fields: [{ name: 'Reason', value: sent.reason || 'unknown', inline: false }],
            footer: 'No entries were added. Try again or contact a senior directly.',
          })],
          embeds: [],
          components: [],
        });
        return;
      }

      await PendingApproval.updateOne(
        { requestId },
        {
          $set: {
            approverIds: sent.deliveredApproverIds,
            approverDmMessages: sent.deliveredDmMessages,
          },
        }
      );

      const waitEmbed = new EmbedBuilder()
        .setTitle('⏳ Bulk Add — Awaiting Senior Approval')
        .setDescription(
          `Your bulk add of **${pending.rows.length} rows** has been sent to Senior for approval.\n\n` +
            `You'll be notified in this channel when the decision is made.`
        )
        .setColor(COLORS.warning)
        .setFooter({ text: `Request ID: ${requestId.slice(0, 8)}` })
        .setTimestamp();

      await interaction.update({
        content: null,
        embeds: [waitEmbed],
        components: [],
      });
    } catch (err) {
      console.error('[multiadd] Approval request create failed:', err);
      await PendingApproval.deleteOne({ requestId }).catch(() => {});
      await interaction.update({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Approval Request Failed',
          description: 'Could not create the bulk-approval request.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
          footer: 'No entries were added. Retry the upload; if it persists, contact a senior.',
        })],
        embeds: [],
        components: [],
      }).catch(() => {});
    }
  };
}
