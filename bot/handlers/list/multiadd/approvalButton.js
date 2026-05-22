import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import { COLORS } from '../../../utils/ui.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  editPayload,
  replyAlert,
  updateAlert,
  updateEmbed,
  updatePayload,
} from '../../../utils/interactionReplies.js';

export function createMultiaddApprovalButtonHandler(deps) {
  const {
    client,
    syncApproverDmMessages,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = deps;

  return async function handleMultiaddApprovalButton(interaction) {
    const [prefix, requestId] = interaction.customId.split(':');
    await connectDB();

    const payload = await PendingApproval.findOneAndDelete({
      requestId,
      action: 'bulk',
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId, action: 'bulk' });
      if (stillExists) {
        await replyAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: 'Not Authorised',
          description: 'You are not on the approver list for this request.',
        });
      } else {
        await updateAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Request Expired',
          description: 'This bulk-approval request has already been processed or expired.',
        }, {
          content: '',
          components: [],
        }).catch(() => {});
      }
      return;
    }

    const meta = {
      guildId: payload.guildId,
      channelId: payload.channelId,
      requesterId: payload.requestedByUserId,
      requesterTag: payload.requestedByTag,
      requesterName: payload.requestedByName,
      requesterDisplayName: payload.requestedByDisplayName,
    };

    if (prefix === 'multiaddapprove_reject') {
      // Count per-list-type so the reject card carries the same
      // breakdown shape the approval card does. Gives the requester
      // (and any other approver scrolling DMs) one-glance context for
      // what was thrown out.
      const rejectCounts = { black: 0, white: 0, watch: 0 };
      for (const row of payload.bulkRows || []) {
        if (row.type && rejectCounts[row.type] !== undefined) rejectCounts[row.type] += 1;
      }
      const breakdown = [];
      if (rejectCounts.black > 0) breakdown.push(`⛔ **${rejectCounts.black}**`);
      if (rejectCounts.watch > 0) breakdown.push(`⚠️ **${rejectCounts.watch}**`);
      if (rejectCounts.white > 0) breakdown.push(`✅ **${rejectCounts.white}**`);

      const rejectEmbed = new EmbedBuilder()
        .setTitle(`✖️ Bulk Add · Rejected · ${payload.bulkRows.length} rows`)
        .setDescription(`<@${interaction.user.id}> rejected the bulk-add request.`)
        .setColor(COLORS.danger)
        .addFields(
          {
            name: '👤 Requested by',
            value: `${payload.requestedByDisplayName || payload.requestedByTag || 'Unknown'} (<@${payload.requestedByUserId}>)`,
            inline: false,
          },
          {
            name: '📊 Rows discarded',
            value: breakdown.length > 0 ? breakdown.join(' · ') : `**${payload.bulkRows.length}** rows`,
            inline: true,
          },
          {
            name: '🆔 Request ID',
            value: `\`${payload.requestId.slice(0, 8)}\``,
            inline: true,
          },
        )
        .setFooter({ text: '🛡️ Bulk-add approval flow · request consumed, nothing was written to the DB' })
        .setTimestamp();

      await updateEmbed(interaction, rejectEmbed, {
        components: [],
      }).catch(() => {});

      await syncApproverDmMessages(
        payload,
        { embeds: [rejectEmbed], components: [] },
        { excludeMessageId: interaction.message?.id || '' }
      ).catch((err) => console.warn('[multiadd] DM sync failed:', err.message));

      try {
        const guild = await client.guilds.fetch(payload.guildId);
        const channel = await guild.channels.fetch(payload.channelId);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `<@${payload.requestedByUserId}> ❌ Your bulk add of **${payload.bulkRows.length} rows** was rejected by Senior.`,
          });
        }
      } catch (err) {
        console.warn('[multiadd] Failed to notify requester of rejection:', err.message);
      }
      return;
    }

    if (prefix !== 'multiaddapprove_approve') return;

    await updatePayload(interaction, {
      content: `⏳ Approved. Processing ${payload.bulkRows.length} rows...`,
      embeds: [],
      components: [],
    }).catch(() => {});

    const rows = payload.bulkRows.map((row) => ({
      name: row.name,
      type: row.type,
      reason: row.reason,
      raid: row.raid || '',
      logs: row.logsUrl || '',
      image: row.imageUrl || '',
      imageMessageId: row.imageMessageId || '',
      imageChannelId: row.imageChannelId || '',
      scope: row.scope || '',
      rowNum: 0,
    }));

    const results = await executeBulkMultiadd(rows, meta, null);

    broadcastBulkAdd(results.added, {
      guildId: payload.guildId,
      requestedByDisplayName: payload.requestedByDisplayName,
    }).catch((err) => console.warn('[multiadd] Bulk broadcast failed:', err.message));

    const summaryEmbed = buildBulkSummaryEmbed(results, meta);
    summaryEmbed.addFields({
      name: 'Approved by',
      value: `<@${interaction.user.id}>`,
      inline: false,
    });

    await editPayload(interaction, {
      content: null,
      embeds: [summaryEmbed],
      components: [],
    }).catch(() => {});

    await syncApproverDmMessages(
      payload,
      { embeds: [summaryEmbed], components: [] },
      { excludeMessageId: interaction.message?.id || '' }
    ).catch((err) => console.warn('[multiadd] DM sync failed:', err.message));

    try {
      const guild = await client.guilds.fetch(payload.guildId);
      const channel = await guild.channels.fetch(payload.channelId);
      if (channel?.isTextBased()) {
        await channel.send({
          content: `<@${payload.requestedByUserId}> ✅ Your bulk add was approved by Senior.`,
          embeds: [summaryEmbed],
        });
      }
    } catch (err) {
      console.warn('[multiadd] Failed to notify requester of approval:', err.message);
    }
  };
}
