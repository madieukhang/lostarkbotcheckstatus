import { randomUUID } from 'node:crypto';

import { connectDB } from '../../../db.js';
import { parseMultiaddFile } from '../../../services/multiadd/index.js';
import { getInteractionDisplayName } from '../../../utils/names.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferEphemeralReply,
  editAlert,
  editEmbed,
  editPayload,
} from '../../../utils/interactionReplies.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  downloadMultiaddAttachment,
  validateMultiaddAttachment,
} from './attachment.js';
import { createMultiaddApprovalButtonHandler } from './approvalButton.js';
import { createMultiaddConfirmButtonHandler } from './confirmButton.js';
import {
  buildNoValidRowsEmbed,
  buildPreviewReply,
  buildTemplateReply,
} from './ui.js';

const MULTIADD_PENDING_TTL_MS = 5 * 60 * 1000;

export function createMultiaddHandlers({ client, services }) {
  const {
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = services;

  const multiaddPending = new Map();

  function clearMultiaddPending(requestId) {
    const entry = multiaddPending.get(requestId);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    multiaddPending.delete(requestId);
  }

  async function handleListMultiaddCommand(interaction) {
    const action = interaction.options.getString('action', true);
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    if (!interaction.guild) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.common.serverOnly', lang),
        lang,
      });
      return;
    }

    if (action === 'template') {
      try {
        await editPayload(interaction, await buildTemplateReply(lang));
      } catch (err) {
        console.error('[multiadd] Template generation failed:', err);
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          ...t('dialogue.multiadd.errors.template', lang),
          fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
          lang,
        });
      }
      return;
    }

    if (action === 'file') {
      const file = interaction.options.getAttachment('file');
      const validationError = validateMultiaddAttachment(file, lang);
      if (validationError) {
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: t('dialogue.multiadd.errors.invalidAttachment', lang),
          description: validationError,
          lang,
        });
        return;
      }

      const download = await downloadMultiaddAttachment(file, lang);
      if (!download.ok) {
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: t('dialogue.multiadd.errors.download', lang),
          description: download.content,
          lang,
        });
        return;
      }

      const parsed = await parseMultiaddFile(download.buffer);
      if (!parsed.ok) {
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          ...t('dialogue.multiadd.errors.parse', lang),
          fields: [{ name: t('dialogue.common.errorField', lang), value: parsed.error || t('dialogue.common.unknown', lang), inline: false }],
          lang,
        });
        return;
      }

      if (parsed.rows.length === 0) {
        await editEmbed(interaction, buildNoValidRowsEmbed(parsed.errors, lang));
        return;
      }

      const requestId = randomUUID();
      await connectDB();
      const expiryTimer = setTimeout(() => {
        multiaddPending.delete(requestId);
      }, MULTIADD_PENDING_TTL_MS);

      multiaddPending.set(requestId, {
        rows: parsed.rows,
        errors: parsed.errors,
        requesterId: interaction.user.id,
        requesterTag: interaction.user.tag,
        requesterName: interaction.user.username,
        requesterDisplayName: getInteractionDisplayName(interaction),
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        createdAt: Date.now(),
        expiryTimer,
      });

      await editPayload(interaction, buildPreviewReply(parsed, requestId, lang));
      return;
    }

    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.multiadd.errors.unknownAction', lang, { action }),
      lang,
    });
  }

  const sharedDeps = {
    client,
    multiaddPending,
    clearMultiaddPending,
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  };

  return {
    handleListMultiaddCommand,
    handleMultiaddConfirmButton: createMultiaddConfirmButtonHandler(sharedDeps),
    handleMultiaddApprovalButton: createMultiaddApprovalButtonHandler(sharedDeps),
  };
}
