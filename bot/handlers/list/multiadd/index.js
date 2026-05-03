import { randomUUID } from 'node:crypto';

import { parseMultiaddFile } from '../../../services/multiaddTemplateService.js';
import { getInteractionDisplayName } from '../../../utils/names.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
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
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Server-Only Command',
          description: 'This command can only be used inside a Discord server, not in DMs.',
        })],
        ephemeral: true,
      });
      return;
    }

    if (action === 'template') {
      await interaction.deferReply({ ephemeral: true });
      try {
        await interaction.editReply(await buildTemplateReply());
      } catch (err) {
        console.error('[multiadd] Template generation failed:', err);
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Template Generation Failed',
            description: 'Could not produce the bulk-add template file.',
            fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
          })],
        });
      }
      return;
    }

    if (action === 'file') {
      const file = interaction.options.getAttachment('file');
      const validationError = validateMultiaddAttachment(file);
      if (validationError) {
        await interaction.reply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Invalid Attachment',
            description: validationError,
          })],
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      const download = await downloadMultiaddAttachment(file);
      if (!download.ok) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Download Failed',
            description: download.content,
          })],
        });
        return;
      }

      const parsed = await parseMultiaddFile(download.buffer);
      if (!parsed.ok) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Parse Failed',
            description: 'Could not read the uploaded file.',
            fields: [{ name: 'Error', value: parsed.error || 'unknown', inline: false }],
            footer: 'Make sure the file is the unmodified template, .xlsx format.',
          })],
        });
        return;
      }

      if (parsed.rows.length === 0) {
        await interaction.editReply({ embeds: [buildNoValidRowsEmbed(parsed.errors)] });
        return;
      }

      const requestId = randomUUID();
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

      await interaction.editReply(buildPreviewReply(parsed, requestId));
      return;
    }

    await interaction.reply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.ERROR,
        title: 'Unknown Action',
        description: `\`${action}\` is not a valid multiadd action.`,
        footer: 'Valid actions: template (download blank), file (upload filled).',
      })],
      ephemeral: true,
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
