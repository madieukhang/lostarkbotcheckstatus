import { createArtistEmbed } from '../../../utils/artistVoice.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import GuildConfig from '../../../models/GuildConfig.js';
import UserPreference from '../../../models/UserPreference.js';
import { COLORS } from '../../../utils/ui.js';
import { AlertSeverity, buildNoticeEmbed } from '../../../utils/alertEmbed.js';
import {
  editPayload,
  replyAlert,
  updateAlert,
  updateEmbed,
  updateNotice,
} from '../../../utils/interactionReplies.js';
import { getGuildLanguage, getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  PENDING_APPROVAL_ACCESS,
  resolvePendingApprovalAccess,
} from '../services/pendingApprovalAccess.js';

export async function notifyMultiaddRequester({
  client,
  payload,
  copyKey,
  copyValues = {},
  severity,
  buildExtraEmbeds = () => [],
  failureLabel,
  GuildConfigModel = GuildConfig,
  getGuildLanguageFn = getGuildLanguage,
  translate = t,
  buildNoticeEmbedFn = buildNoticeEmbed,
  logger = console,
}) {
  try {
    const guild = await client.guilds.fetch(payload.guildId);
    const channel = await guild.channels.fetch(payload.channelId);
    if (!channel?.isTextBased()) return false;

    const lang = await getGuildLanguageFn(guild.id, { GuildConfigModel });
    const mention = `<@${payload.requestedByUserId}>`;
    const copy = translate(copyKey, lang, {
      user: payload.requestedByUserId,
      ...copyValues,
    });
    await channel.send({
      content: mention,
      allowedMentions: { users: [payload.requestedByUserId] },
      embeds: [
        buildNoticeEmbedFn(copy.replace(mention, '').trim(), { severity, lang }),
        ...buildExtraEmbeds(lang),
      ],
    });
    return true;
  } catch (err) {
    logger.warn?.(failureLabel, err.message);
    return false;
  }
}

function buildRejectBreakdown(rows = []) {
  const counts = { black: 0, white: 0, watch: 0 };
  for (const row of rows) {
    if (row.type && counts[row.type] !== undefined) counts[row.type] += 1;
  }

  return [
    ['black', '⛔'],
    ['watch', '⚠️'],
    ['white', '✅'],
  ]
    .filter(([type]) => counts[type] > 0)
    .map(([type, icon]) => `${icon} **${counts[type]}**`);
}

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
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    await connectDB();

    const approvalAccess = await resolvePendingApprovalAccess({
      PendingApprovalModel: PendingApproval,
      requestId,
      approverId: interaction.user.id,
      filters: { action: 'bulk' },
      consume: true,
    });
    const { payload } = approvalAccess;

    if (!payload) {
      if (approvalAccess.status === PENDING_APPROVAL_ACCESS.notAuthorized) {
        await replyAlert(interaction, {
          severity: AlertSeverity.ERROR,
          ...t('dialogue.approval.flow.notAuthorized', lang),
          lang,
        });
      } else {
        await updateAlert(interaction, {
          severity: AlertSeverity.WARNING,
          ...t('dialogue.approval.flow.expired', lang),
          lang,
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
      const breakdown = buildRejectBreakdown(payload.bulkRows);

      const buildRejectEmbed = (targetLang) => createArtistEmbed(targetLang)
        .setTitle(`✖️ ${t('dialogue.multiadd.approval.rejectedTitle', targetLang, { count: payload.bulkRows.length })}`)
        .setDescription(t('dialogue.multiadd.approval.rejectedDescription', targetLang, { user: interaction.user.id }))
        .setColor(COLORS.danger)
        .addFields(
          { name: `👤 ${t('dialogue.approval.fields.requestedBy', targetLang)}`, value: `${payload.requestedByDisplayName || payload.requestedByTag || t('dialogue.common.unknown', targetLang)} (<@${payload.requestedByUserId}>)`, inline: false },
          { name: `📊 ${t('dialogue.multiadd.approval.rowsDiscarded', targetLang)}`, value: breakdown.length > 0 ? breakdown.join(' · ') : `**${payload.bulkRows.length}**`, inline: true },
          { name: `🆔 ${t('dialogue.approval.fields.requestId', targetLang)}`, value: `\`${payload.requestId.slice(0, 8)}\``, inline: true },
        )
        .setFooter({ text: `🛡️ ${t('dialogue.multiadd.approval.rejectedFooter', targetLang)}` })
        .setTimestamp();
      const rejectEmbed = buildRejectEmbed(lang);

      await updateEmbed(interaction, rejectEmbed, {
        components: [],
      }).catch(() => {});

      await syncApproverDmMessages(
        payload,
        (targetLang) => ({ embeds: [buildRejectEmbed(targetLang)], components: [] }),
        { excludeMessageId: interaction.message?.id || '' }
      ).catch((err) => console.warn('[multiadd] DM sync failed:', err.message));

      await notifyMultiaddRequester({
        client,
        payload,
        copyKey: 'dialogue.multiadd.approval.publicRejected',
        copyValues: { count: payload.bulkRows.length },
        severity: AlertSeverity.ERROR,
        failureLabel: '[multiadd] Failed to notify requester of rejection:',
      });
      return;
    }

    if (prefix !== 'multiaddapprove_approve') return;

    await updateNotice(interaction, t('dialogue.multiadd.approval.processing', lang, {
      count: payload.bulkRows.length,
    }), {
      severity: AlertSeverity.INFO,
      titleIcon: '⏳',
      lang,
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

    const buildApprovedSummary = (targetLang) => {
      const embed = buildBulkSummaryEmbed(results, meta, targetLang);
      embed.addFields({ name: `👤 ${t('dialogue.multiadd.approval.approvedBy', targetLang)}`, value: `<@${interaction.user.id}>`, inline: false });
      return embed;
    };
    const summaryEmbed = buildApprovedSummary(lang);

    await editPayload(interaction, {
      content: null,
      embeds: [summaryEmbed],
      components: [],
    }).catch(() => {});

    await syncApproverDmMessages(
      payload,
      (targetLang) => ({ embeds: [buildApprovedSummary(targetLang)], components: [] }),
      { excludeMessageId: interaction.message?.id || '' }
    ).catch((err) => console.warn('[multiadd] DM sync failed:', err.message));

    await notifyMultiaddRequester({
      client,
      payload,
      copyKey: 'dialogue.multiadd.approval.publicApproved',
      severity: AlertSeverity.SUCCESS,
      buildExtraEmbeds: (guildLang) => [buildApprovedSummary(guildLang)],
      failureLabel: '[multiadd] Failed to notify requester of approval:',
    });
  };
}
