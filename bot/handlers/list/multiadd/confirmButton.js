import { createArtistEmbed } from '../../../utils/artistVoice.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { COLORS } from '../../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  editPayload,
  replyAlert,
  updateAlert,
  updatePayload,
} from '../../../utils/interactionReplies.js';
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
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const pending = multiaddPending.get(requestId);

    if (!pending) {
      await updateAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.multiadd.confirm.expired', lang),
        lang,
      }, {
        content: '',
        components: [],
      });
      return;
    }

    if (interaction.user.id !== pending.requesterId) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.multiadd.confirm.notYours', lang),
        lang,
      });
      return;
    }

    if (prefix === 'multiadd_cancel') {
      clearMultiaddPending(requestId);
      await updatePayload(interaction, {
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.INFO,
          titleIcon: '✖️',
          ...t('dialogue.multiadd.confirm.cancelled', lang),
          lang,
        })],
        components: [],
      });
      return;
    }

    if (prefix !== 'multiadd_confirm') return;

    clearMultiaddPending(requestId);

    if (isOfficerOrSenior(pending.requesterId)) {
      await updatePayload(interaction, {
        content: `⏳ ${t('dialogue.multiadd.confirm.processing', lang, { count: pending.rows.length, seconds: Math.ceil(pending.rows.length * 0.7) })}`,
        embeds: [],
        components: [],
      });

      const onProgress = async (current, total) => {
        if (current % 5 !== 0 && current !== total) return;
        try {
          await editPayload(interaction, {
            content: `⏳ ${t('dialogue.multiadd.confirm.progress', lang, { current, total })}`,
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
        await updatePayload(interaction, {
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            ...t('dialogue.multiadd.confirm.routing', lang),
            lang,
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
        await updatePayload(interaction, {
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            ...t('dialogue.multiadd.confirm.delivery', lang),
            fields: [{ name: t('dialogue.broadcast.fields.reason', lang), value: sent.reason || t('dialogue.common.unknown', lang), inline: false }],
            lang,
          })],
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

      const waitEmbed = createArtistEmbed(lang)
        .setTitle(`⏳ ${t('dialogue.multiadd.confirm.awaiting.title', lang)}`)
        .setDescription(t('dialogue.multiadd.confirm.awaiting.description', lang, { count: pending.rows.length }))
        .setColor(COLORS.warning)
        .setFooter({ text: t('dialogue.multiadd.confirm.awaiting.footer', lang, { id: requestId.slice(0, 8) }) })
        .setTimestamp();

      await updatePayload(interaction, {
        content: null,
        embeds: [waitEmbed],
        components: [],
      });
    } catch (err) {
      console.error('[multiadd] Approval request create failed:', err);
      await PendingApproval.deleteOne({ requestId }).catch(() => {});
      await updatePayload(interaction, {
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          ...t('dialogue.multiadd.confirm.requestFailed', lang),
          fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
          lang,
        })],
        components: [],
      }).catch(() => {});
    }
  };
}
