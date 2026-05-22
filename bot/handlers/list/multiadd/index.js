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
  replyAlert,
} from '../../../utils/interactionReplies.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage } from '../../../services/i18n/index.js';
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

    if (!interaction.guild) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Server-Only Command',
        description: 'This command can only be used inside a Discord server, not in DMs.',
      });
      return;
    }

    if (action === 'template') {
      await deferEphemeralReply(interaction);
      try {
        await editPayload(interaction, await buildTemplateReply());
      } catch (err) {
        console.error('[multiadd] Template generation failed:', err);
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: 'Template Generation Failed',
          description: 'Could not produce the bulk-add template file.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        });
      }
      return;
    }

    if (action === 'file') {
      const file = interaction.options.getAttachment('file');
      const validationError = validateMultiaddAttachment(file);
      if (validationError) {
        await replyAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: 'Invalid Attachment',
          description: validationError,
        });
        return;
      }

      await deferEphemeralReply(interaction);

      const download = await downloadMultiaddAttachment(file);
      if (!download.ok) {
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: 'Download Failed',
          description: download.content,
        });
        return;
      }

      const parsed = await parseMultiaddFile(download.buffer);
      if (!parsed.ok) {
        await editAlert(interaction, {
          severity: AlertSeverity.ERROR,
          title: 'Parse Failed',
          description: 'Could not read the uploaded file.',
          fields: [{ name: 'Error', value: parsed.error || 'unknown', inline: false }],
          footer: 'Make sure the file is the unmodified template, .xlsx format.',
        });
        return;
      }

      if (parsed.rows.length === 0) {
        await editEmbed(interaction, buildNoValidRowsEmbed(parsed.errors));
        return;
      }

      const requestId = randomUUID();
      await connectDB();
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
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

    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      title: 'Unknown Action',
      description: `\`${action}\` is not a valid multiadd action.`,
      footer: 'Valid actions: template (download blank), file (upload filled).',
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
