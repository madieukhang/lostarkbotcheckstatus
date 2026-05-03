import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import {
  getListContext,
  buildApprovalResultRow,
  buildApprovalProcessingRow,
} from '../helpers.js';
import { handleApprovedEditRequest } from './editApproval.js';

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

    // Find but don't delete yet — need to keep for duplicate overwrite flow
    const payload = await PendingApproval.findOne({
      requestId,
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId });

      if (stillExists) {
        await interaction.reply({
          content: '⛔ You are not allowed to approve/reject this request.',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: '⚠️ This approval request was already processed or has expired.',
        ephemeral: true,
      });
      return;
    }

    const isApproveAction = action === 'listadd_approve';

    // Acknowledge immediately, then show processing state to avoid 3s timeout issues.
    await interaction.deferUpdate();

    await interaction.editReply({
      content: isApproveAction
        ? `⏳ Processing approval by **${interaction.user.tag}**...`
        : `⏳ Processing rejection by **${interaction.user.tag}**...`,
      components: [buildApprovalProcessingRow(action)],
    });

    await syncApproverDmMessages(
      payload,
      {
        content: isApproveAction
          ? `⏳ Processing approval by **${interaction.user.tag}**...`
          : `⏳ Processing rejection by **${interaction.user.tag}**...`,
        components: [buildApprovalProcessingRow(action)],
      },
      { excludeMessageId: interaction.message.id }
    );

    if (!isApproveAction) {
      await PendingApproval.deleteOne({ requestId });

      await interaction.editReply({
        content: `❌ Rejected by **${interaction.user.tag}**`,
        components: [buildApprovalResultRow('Rejected')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `❌ Rejected by **${interaction.user.tag}**`,
          components: [buildApprovalResultRow('Rejected')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    try {
      // Edit approval — update/move existing entry by _id (not add new)
      if (payload.action === 'edit' && payload.existingEntryId) {
        await handleApprovedEditRequest({
          client,
          interaction,
          payload,
          requestId,
          syncApproverDmMessages,
          broadcastListChange,
          notifyRequesterAboutDecision,
        });
        return;
      }

      const result = await executeListAddToDatabase(payload);

      // Duplicate found — show comparison and overwrite option
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
          .setTitle('⚠️ Duplicate Found — Compare')
          .addFields(
            { name: `📌 Existing Entry${existingScopeTag}`, value: `**${existing.name}**\nReason: ${existing.reason || 'N/A'}\nRaid: ${existing.raid || 'N/A'}\nAdded: <t:${Math.floor(new Date(existing.addedAt || 0).getTime() / 1000)}:R>`, inline: true },
            { name: `🆕 New Request${requestScopeTag}`, value: `**${payload.name}**\nReason: ${payload.reason || 'N/A'}\nRaid: ${payload.raid || 'N/A'}\nBy: ${payload.requestedByDisplayName || 'Unknown'}`, inline: true },
          )
          .setColor(0xfee75c);

        const overwriteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`listadd_overwrite:${requestId}`)
            .setLabel('Overwrite')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`listadd_keep:${requestId}`)
            .setLabel('Keep Existing')
            .setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({
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
        // Don't delete PendingApproval — needed for overwrite flow
        return;
      }

      // Success or non-duplicate error — clean up
      await PendingApproval.deleteOne({ requestId });

      await interaction.editReply({
        content: result.ok
          ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
          : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: result.ok
            ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
            : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
          components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, result, false);
    } catch (err) {
      await PendingApproval.deleteOne({ requestId });

      await interaction.editReply({
        content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
        components: [buildApprovalResultRow('Failed')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
          components: [buildApprovalResultRow('Failed')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(
        payload,
        { content: `⚠️ Failed to execute approved request: \`${err.message}\``, embeds: [] },
        false
      );
    }
  }

  return handleListAddApprovalButton;
}
