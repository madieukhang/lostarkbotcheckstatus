/**
 * handlers/list/services/approvals.js
 * Approval DM dispatch + sync helpers shared across /la-list add,
 * edit, multiadd, and quickadd. Fans out the approval request to
 * every assigned approver, tracks the message IDs so a decision in
 * one DM mirrors to the others (syncApproverDmMessages), and posts
 * the requester-DM with the final decision.
 */

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
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';

/**
 * Build the approval DM service bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   for user DM fetching + message edits across the approver fan-out.
 * @returns {{
 *   sendListAddApprovalToApprovers: Function,
 *   sendBulkApprovalToApprovers: Function,
 *   syncApproverDmMessages: Function,
 *   notifyRequesterAboutDecision: Function,
 * }}
 */
export function createApprovalServices({ client }) {
  async function sendListAddApprovalToApprovers(guild, payload, options = {}) {
    const approverIds = getApproverRecipientIds();
    if (approverIds.length === 0) {
      return { success: false, reason: 'No approver user IDs configured. Set SENIOR_APPROVER_IDS or OFFICER_APPROVER_IDS in env.' };
    }

    const buildRow = (lang) => {
      // Buttons are persistent; the evidence button resolves a fresh URL on click.
      const buttons = [
        new ButtonBuilder()
          .setCustomId(`listadd_approve:${payload.requestId}`)
          .setLabel(t('common.actions.approve', lang))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`listadd_reject:${payload.requestId}`)
          .setLabel(t('common.actions.reject', lang))
          .setStyle(ButtonStyle.Danger),
      ];
      if (payload.imageMessageId || payload.imageUrl) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`listadd_viewevidence:${payload.requestId}`)
            .setLabel(t('common.actions.viewEvidenceFresh', lang))
            .setStyle(ButtonStyle.Secondary)
        );
      }
      return new ActionRowBuilder().addComponents(buttons);
    };

    const embed = buildListAddApprovalEmbed(guild, payload, options);
    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;
          const lang = await getUserLanguage(user.id, { UserPreferenceModel: UserPreference });

          const sentMessage = await user.send({ embeds: [embed], components: [buildRow(lang)] });
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

    const buildRow = (lang) => new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`multiaddapprove_approve:${pending.requestId}`)
          .setLabel(t('common.actions.approveAdd', lang, { count: pending.rows.length }))
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`multiaddapprove_reject:${pending.requestId}`)
          .setLabel(t('common.actions.reject', lang))
          .setStyle(ButtonStyle.Danger)
          .setEmoji('✖️')
      );

    const typeIcon = (type) => (type === 'black' ? '⛔' : type === 'white' ? '✅' : '⚠️');

    // Per-type breakdown gives the senior a quick "what am I about to
    // approve?" read before they parse the line list. A bulk batch of
    // 30 rows skewed heavily blacklist deserves visible warning vs an
    // all-whitelist batch which is mostly mechanical.
    const typeCounts = { black: 0, white: 0, watch: 0 };
    let serverScopedCount = 0;
    for (const r of pending.rows) {
      if (typeCounts[r.type] !== undefined) typeCounts[r.type]++;
      if (r.scope === 'server') serverScopedCount++;
    }
    const breakdownParts = [];
    if (typeCounts.black) breakdownParts.push(`⛔ **${typeCounts.black}**`);
    if (typeCounts.watch) breakdownParts.push(`⚠️ **${typeCounts.watch}**`);
    if (typeCounts.white) breakdownParts.push(`✅ **${typeCounts.white}**`);
    if (serverScopedCount > 0) breakdownParts.push(`🏠 **${serverScopedCount}** local`);

    const previewLines = pending.rows.slice(0, 20).map((r, i) => {
      const reasonShort = (r.reason || '').length > 40 ? (r.reason || '').slice(0, 37) + '...' : (r.reason || '');
      const scopeTag = r.scope === 'server' ? ' `[Local]`' : '';
      const raidTag = r.raid ? ` \`${r.raid}\`` : '';
      return `\`${String(i + 1).padStart(2, ' ')}.\` ${typeIcon(r.type)} **${r.name}**${scopeTag}${raidTag} · ${reasonShort}`;
    });
    if (pending.rows.length > 20) {
      previewLines.push(`*... and ${pending.rows.length - 20} more rows*`);
    }

    // Color follows the dominant outcome: blacklist-heavy batches tint
    // red, whitelist-heavy go green, watch-heavy yellow. Mixed batches
    // fall back to blurple. Approvers reading a stack of DMs scan
    // colors first.
    let color;
    if (typeCounts.black >= typeCounts.white && typeCounts.black >= typeCounts.watch) color = COLORS.danger;
    else if (typeCounts.watch >= typeCounts.white) color = COLORS.warning;
    else color = COLORS.success;

    const headerLine = breakdownParts.length > 0
      ? `**Outcome:** ${breakdownParts.join(' · ')}`
      : `Reviewing **${pending.rows.length}** entries.`;

    const embed = new EmbedBuilder()
      .setTitle(`📋 Bulk Add Approval · ${pending.rows.length} rows`)
      .setDescription(`${headerLine}\n\n${previewLines.join('\n').slice(0, 3800)}`)
      .setColor(color)
      .addFields(
        {
          name: '👤 Requested by',
          value: `${pending.requesterDisplayName || pending.requesterTag || 'Unknown'} (<@${pending.requesterId}>)`,
          inline: false,
        },
        {
          name: '🏠 Server',
          value: guild?.name || pending.guildId || 'Unknown',
          inline: true,
        },
        {
          name: '📊 Total',
          value: String(pending.rows.length),
          inline: true,
        },
        {
          name: '🆔 Request ID',
          value: `\`${pending.requestId.slice(0, 8)}\``,
          inline: true,
        },
      )
      .setFooter({ text: '🛡️ Approve / Reject buttons below · Lost Ark Check approval flow' })
      .setTimestamp(new Date());

    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;
          const lang = await getUserLanguage(user.id, { UserPreferenceModel: UserPreference });

          const sentMessage = await user.send({ embeds: [embed], components: [buildRow(lang)] });
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
