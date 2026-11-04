import { createArtistEmbed } from '../../../utils/artistVoice.js';

import GuildConfig from '../../../models/GuildConfig.js';
import { COLORS } from '../../../utils/ui.js';
import { NoticeKind, buildAlertEmbed } from '../../../utils/alertEmbed.js';
import {
  editAlert,
  editPayload,
  editEmbed,
} from '../../../utils/interactionReplies.js';
import { getGuildLanguage, t } from '../../../services/i18n/index.js';
import { buildApprovalRetryRow, listTypeIcon } from '../helpers.js';
import { createApprovalDecisionHandler, handleApprovalClaimError } from '../services/approvalInteraction.js';

/**
 * Post the decision on a bulk add in the channel it was requested from. The
 * mention rides in the message content, where Discord notifies; the card is
 * neutral copy in the guild's language.
 * @param {object} options - the `...Fn`, `translate` and `logger` options are
 *   injectable for tests
 * @param {object} options.payload - pending bulk approval with guildId,
 *   channelId and requestedByUserId
 * @param {string} options.copyKey - locale key holding the title and description
 * @param {object} [options.copyValues] - placeholder values for the copy
 * @param {string} options.kind - NoticeKind of the decision notice
 * @param {Function} [options.buildExtraEmbeds] - embeds after the notice, by language
 * @param {string} options.failureLabel - log prefix when the post fails
 * @returns {Promise<boolean>} whether the notice was posted
 */
export async function notifyMultiaddRequester({
  client,
  payload,
  copyKey,
  copyValues = {},
  kind,
  buildExtraEmbeds = () => [],
  failureLabel,
  GuildConfigModel = GuildConfig,
  getGuildLanguageFn = getGuildLanguage,
  translate = t,
  buildAlertEmbedFn = buildAlertEmbed,
  logger = console,
}) {
  try {
    const guild = await client.guilds.fetch(payload.guildId);
    const channel = await guild.channels.fetch(payload.channelId);
    if (!channel?.isTextBased()) return false;

    const lang = await getGuildLanguageFn(guild.id, { GuildConfigModel });
    await channel.send({
      content: `<@${payload.requestedByUserId}>`,
      allowedMentions: { users: [payload.requestedByUserId] },
      embeds: [
        buildAlertEmbedFn({ kind, ...translate(copyKey, lang, copyValues) }),
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

  return ['black', 'watch', 'white']
    .filter((type) => counts[type] > 0)
    .map((type) => `${listTypeIcon(type)} **${counts[type]}**`);
}

export function createMultiaddApprovalButtonHandler(deps) {
  const {
    client,
    syncApproverDmMessages,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = deps;

  return createApprovalDecisionHandler(async ({ interaction, action: prefix, requestId, lang, payload, claim }) => {
    try {
      const meta = {
        guildId: payload.guildId,
        channelId: payload.channelId,
        requesterId: payload.requestedByUserId,
        requesterTag: payload.requestedByTag,
        requesterName: payload.requestedByName,
        requesterDisplayName: payload.requestedByDisplayName,
      };

      if (prefix === 'multiaddapprove_reject') {
        await claim.complete();
        // Count per-list-type so the reject card carries the same
        // breakdown shape the approval card does. Gives the requester
        // (and any other approver scrolling DMs) one-glance context for
        // what was thrown out.
        const breakdown = buildRejectBreakdown(payload.bulkRows);

        const buildRejectEmbed = (targetLang) => createArtistEmbed()
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

        await editEmbed(interaction, rejectEmbed, {
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
          kind: NoticeKind.GUARD,
          failureLabel: '[multiadd] Failed to notify requester of rejection:',
        });
        return;
      }

      if (prefix !== 'multiaddapprove_approve') return;

      await editAlert(interaction, {
        kind: NoticeKind.PROGRESS,
        ...t('dialogue.multiadd.approval.processing', lang, { count: payload.bulkRows.length }),
      }, {
        content: null,
        components: [buildApprovalRetryRow(prefix, requestId, lang)],
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

      const results = await executeBulkMultiadd(rows, meta, null, { beforeWrite: () => claim.assertOwned() });
      await claim.complete();

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
        kind: NoticeKind.DONE,
        buildExtraEmbeds: (guildLang) => [buildApprovedSummary(guildLang)],
        failureLabel: '[multiadd] Failed to notify requester of approval:',
      });
    } catch (err) {
      if (await handleApprovalClaimError({ claim, interaction, error: err, lang, label: 'Bulk decision' })) return;
      await editAlert(interaction, {
        kind: NoticeKind.FAILURE,
        ...t('dialogue.approval.flow.retryFailed', lang),
        fields: [{ name: t('dialogue.common.fields.details', lang), value: `\`${err.message}\``, inline: false }],
      }, {
        content: null,
        components: [buildApprovalRetryRow(prefix, requestId, lang)],
      });
    }
  }, { filters: { action: 'bulk' } });
}
