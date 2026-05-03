import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import {
  buildListAddApprovalEmbed,
  getApproverRecipientIds,
  getSeniorApproverIds,
} from '../helpers.js';
import { COLORS } from '../../../utils/ui.js';

export function createApprovalServices({ client }) {
  async function sendListAddApprovalToApprovers(guild, payload, options = {}) {
    const approverIds = getApproverRecipientIds();
    if (approverIds.length === 0) {
      return { success: false, reason: 'No approver user IDs configured. Set SENIOR_APPROVER_IDS or OFFICER_APPROVER_IDS in env.' };
    }

    // Buttons are persistent; the evidence button resolves a fresh URL on click.
    const buttons = [
      new ButtonBuilder()
        .setCustomId(`listadd_approve:${payload.requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`listadd_reject:${payload.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    ];
    if (payload.imageMessageId || payload.imageUrl) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`listadd_viewevidence:${payload.requestId}`)
          .setLabel('📎 View Evidence (Fresh)')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    const row = new ActionRowBuilder().addComponents(buttons);

    const embed = buildListAddApprovalEmbed(guild, payload, options);
    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;

          const sentMessage = await user.send({ embeds: [embed], components: [row] });
          deliveredApproverIds.push(user.id);
          deliveredDmMessages.push({
            approverId: user.id,
            channelId: sentMessage.channelId,
            messageId: sentMessage.id,
          });
        } catch (err) {
          console.warn(`[list] Failed to DM approver ${approverId}:`, err.message);
        }
      })
    );

    if (deliveredApproverIds.length === 0) {
      return { success: false, reason: 'Unable to DM configured approvers. Check user IDs/privacy settings.' };
    }

    return { success: true, deliveredApproverIds, deliveredDmMessages };
  }

  async function sendBulkApprovalToApprovers(guild, pending) {
    const approverIds = getSeniorApproverIds();
    if (approverIds.length === 0) {
      return {
        success: false,
        reason: 'No Senior approver user IDs configured. Set SENIOR_APPROVER_IDS in env.',
      };
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`multiaddapprove_approve:${pending.requestId}`)
        .setLabel(`Approve · Add ${pending.rows.length}`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`multiaddapprove_reject:${pending.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('✖️')
    );

    const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');
    const previewLines = pending.rows.slice(0, 20).map((r, i) => {
      const reasonShort = (r.reason || '').length > 40 ? (r.reason || '').slice(0, 37) + '...' : (r.reason || '');
      const scopeTag = r.scope === 'server' ? ' `[S]`' : '';
      return `\`${String(i + 1).padStart(2, ' ')}.\` ${typeIcon(r.type)} **${r.name}**${scopeTag} · ${reasonShort}`;
    });
    if (pending.rows.length > 20) {
      previewLines.push(`*... and ${pending.rows.length - 20} more rows*`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`📋 Bulk Add Approval · ${pending.rows.length} rows`)
      .setDescription(previewLines.join('\n').slice(0, 4000))
      .setColor(COLORS.info)
      .addFields(
        {
          name: 'Requested by',
          value: `${pending.requesterDisplayName || pending.requesterTag || 'Unknown'} (<@${pending.requesterId}>)`,
          inline: false,
        },
        {
          name: 'Server',
          value: guild?.name || pending.guildId || 'Unknown',
          inline: true,
        },
      )
      .setFooter({ text: `Request ID: ${pending.requestId.slice(0, 8)}` })
      .setTimestamp(new Date());

    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;

          const sentMessage = await user.send({ embeds: [embed], components: [row] });
          deliveredApproverIds.push(user.id);
          deliveredDmMessages.push({
            approverId: user.id,
            channelId: sentMessage.channelId,
            messageId: sentMessage.id,
          });
        } catch (err) {
          console.warn(`[multiadd] Failed to DM approver ${approverId}:`, err.message);
        }
      })
    );

    if (deliveredApproverIds.length === 0) {
      return {
        success: false,
        reason: 'Unable to DM configured approvers. Check user IDs/privacy settings.',
      };
    }

    return { success: true, deliveredApproverIds, deliveredDmMessages };
  }

  async function syncApproverDmMessages(payload, messageOptions, options = {}) {
    const refs = payload.approverDmMessages || [];
    if (refs.length === 0) return;

    const excludeMessageId = options.excludeMessageId || '';

    await Promise.all(
      refs.map(async (ref) => {
        if (!ref?.channelId || !ref?.messageId) return;
        if (excludeMessageId && ref.messageId === excludeMessageId) return;

        try {
          const dmChannel = await client.channels.fetch(ref.channelId);
          if (!dmChannel || !dmChannel.isTextBased()) return;

          const dmMessage = await dmChannel.messages.fetch(ref.messageId);
          await dmMessage.edit(messageOptions);
        } catch (err) {
          console.warn(`[list] Failed to sync approver DM ${ref.messageId}:`, err.message);
        }
      })
    );
  }

  async function notifyRequesterAboutDecision(payload, result, rejected = false) {
    try {
      const guild = await client.guilds.fetch(payload.guildId);
      const channel = await guild.channels.fetch(payload.channelId);

      if (!channel || !channel.isTextBased()) return;

      const actionLabel = payload.action === 'edit' ? 'edit' : 'add';
      const decisionContent = rejected
        ? `<@${payload.requestedByUserId}> ❌ Your list ${actionLabel} request for **${payload.name}** was rejected by Officer.`
        : `<@${payload.requestedByUserId}> ${result.content}`;

      const decisionPayload = {
        content: decisionContent,
        embeds: rejected ? [] : (result.embeds ?? []),
        components: rejected ? [] : (result.components ?? []),
      };

      if (payload.requestMessageId && 'messages' in channel) {
        try {
          const requestMessage = await channel.messages.fetch(payload.requestMessageId);
          await requestMessage.reply(decisionPayload);
          return;
        } catch (err) {
          console.warn('[list] Failed to reply on original request message, falling back to channel send:', err.message);
        }
      }

      await channel.send(decisionPayload);
    } catch (err) {
      console.warn('[list] Failed to notify requester in origin channel:', err.message);
    }
  }

  return {
    sendListAddApprovalToApprovers,
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    notifyRequesterAboutDecision,
  };
}
