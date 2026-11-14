import { createArtistEmbed } from '../../../utils/artistVoice.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { COLORS, buildProgressBar } from '../../../utils/ui.js';
import { buildAlertEmbed, NoticeKind } from '../../../utils/alertEmbed.js';
import { sleep } from '../../../utils/async.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  editAlert,
  editPayload,
  replyAlert,
  updateAlert,
  updatePayload,
} from '../../../utils/interactionReplies.js';
import {
  getSeniorApproverIds,
  isOfficerOrSenior,
} from '../helpers.js';
import { buildDeliveryFailedAlert } from '../services/mutationFlow.js';
import { buildImageQuotaAlert, takeEvidenceUploads } from '../../../utils/evidenceQuota.js';

const MULTIADD_CONFIRM_STATE_RULES = Object.freeze([
  { state: 'expired', matches: ({ pending }) => !pending },
  {
    state: 'not-yours',
    matches: ({ pending, userId }) => Boolean(pending) && userId !== pending.requesterId,
  },
  { state: 'cancel', matches: ({ prefix }) => prefix === 'multiadd_cancel' },
  { state: 'confirm', matches: ({ prefix }) => prefix === 'multiadd_confirm' },
]);

export function resolveMultiaddConfirmState(context) {
  return MULTIADD_CONFIRM_STATE_RULES.find(({ matches }) => matches(context))?.state || 'ignore';
}

async function settleMultiaddConfirmState({
  state,
  interaction,
  requestId,
  lang,
  clearMultiaddPending,
}) {
  switch (state) {
    case 'expired':
      await updateAlert(interaction, {
        kind: NoticeKind.EXPIRED,
        ...t('dialogue.multiadd.confirm.expired', lang),
      }, {
        content: '',
        components: [],
      });
      return false;
    case 'not-yours':
      await replyAlert(interaction, {
        kind: NoticeKind.GUARD,
        ...t('dialogue.multiadd.confirm.notYours', lang),
      });
      return false;
    case 'cancel':
      clearMultiaddPending(requestId);
      await updatePayload(interaction, {
        content: '',
        embeds: [buildAlertEmbed({
          kind: NoticeKind.DONE,
          ...t('dialogue.multiadd.confirm.cancelled', lang),
        })],
        components: [],
      });
      return false;
    case 'confirm':
      return true;
    default:
      return false;
  }
}

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
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const pending = multiaddPending.get(requestId);
    const state = resolveMultiaddConfirmState({
      prefix,
      pending,
      userId: interaction.user.id,
    });
    const shouldConfirm = await settleMultiaddConfirmState({
      state,
      interaction,
      requestId,
      lang,
      clearMultiaddPending,
    });
    if (!shouldConfirm) return;

    clearMultiaddPending(requestId);

    const imageCount = pending.rows.filter((row) => row.image).length;
    if (!takeEvidenceUploads(pending.requesterId, imageCount)) {
      await updateAlert(interaction, buildImageQuotaAlert(lang), { content: null, components: [] });
      return;
    }

    // Both paths rehost images, write to Mongo and message people before they
    // finish, which outlasts Discord's 3-second window, so the card is
    // acknowledged and its buttons removed before that work starts.
    const seconds = Math.ceil(pending.rows.length * 0.7);
    await updateAlert(interaction, {
      kind: NoticeKind.PROGRESS,
      ...t('dialogue.multiadd.confirm.processing', lang, { count: pending.rows.length, seconds }),
    }, {
      content: null,
      components: [],
    });

    if (isOfficerOrSenior(pending.requesterId)) {
      const onProgress = async (current, total) => {
        if (current % 5 !== 0 && current !== total) return;
        const percent = Math.round((current / total) * 100);
        const { title, description, tip } = t('dialogue.multiadd.confirm.progress', lang, { current, total, seconds });
        // The bar is the scan progress card's, so the two waiting cards match.
        const bar = `\`${buildProgressBar(percent)}\` ${percent}%`;
        try {
          await editAlert(interaction, {
            kind: NoticeKind.PROGRESS,
            title,
            description: [description, bar].join('\n'),
            tip,
          }, { content: null });
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

      const summaryEmbed = buildBulkSummaryEmbed(results, pending, lang);
      await editPayload(interaction, {
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
        await editPayload(interaction, {
          embeds: [buildAlertEmbed({
            kind: NoticeKind.INPUT,
            ...t('dialogue.multiadd.confirm.routing', lang),
          })],
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
          await sleep(200);
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
        await editPayload(interaction, {
          embeds: [buildAlertEmbed(buildDeliveryFailedAlert('dialogue.multiadd.confirm.delivery', sent, lang))],
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

      const waitEmbed = createArtistEmbed()
        .setTitle(`⏳ ${t('dialogue.multiadd.confirm.awaiting.title', lang)}`)
        .setDescription(t('dialogue.multiadd.confirm.awaiting.description', lang, { count: pending.rows.length }))
        .setColor(COLORS.warning)
        .setFooter({ text: t('dialogue.multiadd.confirm.awaiting.footer', lang, { id: requestId.slice(0, 8) }) })
        .setTimestamp();

      // The request and its DMs already exist; a failed card edit must not
      // reach the catch below, which would delete the approval under them.
      await editPayload(interaction, {
        content: null,
        embeds: [waitEmbed],
        components: [],
      }).catch((err) => console.warn('[multiadd] Approval request sent, but the confirm card update failed:', err.message));
    } catch (err) {
      console.error('[multiadd] Approval request create failed:', err);
      await PendingApproval.deleteOne({ requestId }).catch(() => {});
      await editPayload(interaction, {
        embeds: [buildAlertEmbed({
          kind: NoticeKind.FAILURE,
          ...t('dialogue.multiadd.confirm.requestFailed', lang),
          fields: [{ name: t('dialogue.common.fields.details', lang), value: `\`${err.message}\``, inline: false }],
        })],
        components: [],
      }).catch(() => {});
    }
  };
}
