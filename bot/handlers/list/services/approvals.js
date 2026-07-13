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
} from 'discord.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';

import {
  buildListAddApprovalEmbed,
  getApproverRecipientIds,
  getSeniorApproverIds,
  listTypeIcon,
} from '../helpers.js';
import { COLORS } from '../../../utils/ui.js';
import { AlertSeverity, buildNoticeEmbed } from '../../../utils/alertEmbed.js';
import GuildConfig from '../../../models/GuildConfig.js';
import UserPreference from '../../../models/UserPreference.js';
import { getGuildLanguage, getUserLanguage, t } from '../../../services/i18n/index.js';

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
export function createApprovalServices({
  client,
  getUserLanguageFn = getUserLanguage,
  getGuildLanguageFn = getGuildLanguage,
  UserPreferenceModel = UserPreference,
  GuildConfigModel = GuildConfig,
}) {
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

    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;
          const lang = await getUserLanguageFn(user.id, { UserPreferenceModel });
          const embed = buildListAddApprovalEmbed(guild, payload, { ...options, lang });

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

    // Per-type breakdown summarizes the pending batch before the detailed
    // rows. Blacklist-heavy batches receive a stronger visual warning than
    // all-whitelist batches.
    const typeCounts = { black: 0, white: 0, watch: 0 };
    let serverScopedCount = 0;
    for (const r of pending.rows) {
      if (typeCounts[r.type] !== undefined) typeCounts[r.type]++;
      if (r.scope === 'server') serverScopedCount++;
    }
    // Color follows the dominant outcome: blacklist-heavy batches tint
    // red, whitelist-heavy go green, watch-heavy yellow. Mixed batches
    // fall back to blurple. Approvers reading a stack of DMs scan
    // colors first.
    let color;
    if (typeCounts.black >= typeCounts.white && typeCounts.black >= typeCounts.watch) color = COLORS.danger;
    else if (typeCounts.watch >= typeCounts.white) color = COLORS.warning;
    else color = COLORS.success;

    const buildBulkEmbed = (lang) => {
      const breakdownParts = [];
      if (typeCounts.black) breakdownParts.push(`⛔ **${typeCounts.black}**`);
      if (typeCounts.watch) breakdownParts.push(`⚠️ **${typeCounts.watch}**`);
      if (typeCounts.white) breakdownParts.push(`✅ **${typeCounts.white}**`);
      if (serverScopedCount > 0) breakdownParts.push(`🏠 **${serverScopedCount}** ${t('dialogue.approval.bulk.local', lang)}`);

      const previewLines = pending.rows.slice(0, 20).map((row, index) => {
        const reasonShort = (row.reason || '').length > 40 ? `${(row.reason || '').slice(0, 37)}...` : (row.reason || '');
        const scopeTag = row.scope === 'server' ? ` \`[${t('dialogue.approval.scopeTag.local', lang)}]\`` : '';
        const raidTag = row.raid ? ` \`${row.raid}\`` : '';
        return `\`${String(index + 1).padStart(2, ' ')}.\` ${listTypeIcon(row.type)} **${row.name}**${scopeTag}${raidTag} · ${reasonShort}`;
      });
      if (pending.rows.length > 20) {
        previewLines.push(`*${t('dialogue.approval.bulk.more', lang, { count: pending.rows.length - 20 })}*`);
      }
      const headerLine = breakdownParts.length > 0
        ? `**${t('dialogue.approval.bulk.outcome', lang, { breakdown: breakdownParts.join(' · ') })}**`
        : t('dialogue.approval.bulk.reviewing', lang, { count: pending.rows.length });

      return createArtistEmbed(lang)
        .setTitle(`📋 ${t('dialogue.approval.bulk.title', lang, { count: pending.rows.length })}`)
        .setDescription([headerLine, '', previewLines.join('\n').slice(0, 3800)].join('\n'))
        .setColor(color)
        .addFields(
          { name: `👤 ${t('dialogue.approval.fields.requestedBy', lang)}`, value: `${pending.requesterDisplayName || pending.requesterTag || t('dialogue.common.unknown', lang)} (<@${pending.requesterId}>)`, inline: false },
          { name: `🏠 ${t('dialogue.approval.fields.server', lang)}`, value: guild?.name || pending.guildId || t('dialogue.common.unknown', lang), inline: true },
          { name: `📊 ${t('dialogue.approval.fields.total', lang)}`, value: String(pending.rows.length), inline: true },
          { name: `🆔 ${t('dialogue.approval.fields.requestId', lang)}`, value: `\`${pending.requestId.slice(0, 8)}\``, inline: true },
        )
        .setFooter({ text: `🛡️ ${t('dialogue.approval.footer', lang)}` })
        .setTimestamp(new Date());
    };

    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;
          const lang = await getUserLanguageFn(user.id, { UserPreferenceModel });
          const embed = buildBulkEmbed(lang);

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

  async function syncApproverDmMessages(payload, messageOptionsOrBuilder, options = {}) {
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
          const messageOptions = typeof messageOptionsOrBuilder === 'function'
            ? await messageOptionsOrBuilder(
                await getUserLanguageFn(ref.approverId, { UserPreferenceModel }),
                ref,
              )
            : messageOptionsOrBuilder;
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

      const lang = await getGuildLanguageFn(guild.id, { GuildConfigModel });
      const actionLabel = t(`dialogue.approval.public.${payload.action === 'edit' ? 'edit' : 'add'}`, lang);
      const decisionContent = `${rejected ? '❌' : '✅'} ${t(`dialogue.approval.public.${rejected ? 'rejected' : 'approved'}`, lang, {
        user: payload.requestedByUserId,
        action: actionLabel,
        name: payload.name,
      })}`;

      const decisionPayload = {
        // Keep only the ping outside the card; all readable copy belongs to
        // the guild-language embed so the requester still gets notified.
        content: `<@${payload.requestedByUserId}>`,
        allowedMentions: { users: [payload.requestedByUserId] },
        embeds: [buildNoticeEmbed(
          decisionContent.replace(`<@${payload.requestedByUserId}>`, '').trim(),
          {
            severity: rejected ? AlertSeverity.ERROR : AlertSeverity.SUCCESS,
            lang,
          }
        )],
        components: [],
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
