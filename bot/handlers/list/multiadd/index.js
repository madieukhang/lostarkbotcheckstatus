import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import config from '../../../config.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import GuildConfig from '../../../models/GuildConfig.js';
import PendingApproval from '../../../models/PendingApproval.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
  detectAltsViaStronghold,
} from '../../../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../../services/listCheckService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../../utils/imageRehost.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../../../services/multiaddTemplateService.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildListEditSuccessEmbed,
  buildListAddApprovalEmbed,
  getApproverRecipientIds,
  isRequesterAutoApprover,
  isOfficerOrSenior,
  getSeniorApproverIds,
  buildApprovalResultRow,
  buildApprovalProcessingRow,
} from '../helpers.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;

const MULTIADD_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createMultiaddHandlers({ client, services }) {
  const {
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = services;

  // ---------- /la-list multiadd in-memory pending store ----------
  // Keyed by requestId, stores parsed-but-not-yet-confirmed bulk add data.
  // Entries auto-expire after MULTIADD_PENDING_TTL_MS to avoid stale state
  // across bot restarts - on restart this Map is empty and users re-upload.
  const multiaddPending = new Map();

  /** Remove a pending multiadd request and any pending expiry timer. */
  function clearMultiaddPending(requestId) {
    const entry = multiaddPending.get(requestId);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    multiaddPending.delete(requestId);
  }

  async function handleListMultiaddCommand(interaction) {
    const action = interaction.options.getString('action', true);

    if (!interaction.guild) {
      await interaction.reply({
        content: '❌ This command can only be used in a server.',
        ephemeral: true,
      });
      return;
    }

    if (action === 'template') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const buffer = await buildMultiaddTemplate();
        const attachment = new AttachmentBuilder(buffer, {
          name: 'multiadd_template.xlsx',
          description: 'Lost Ark Bot — bulk add template',
        });

        const templateEmbed = new EmbedBuilder()
          .setTitle('📋 Bulk Add Template')
          .setDescription(
            `Fill in up to **${MULTIADD_MAX_ROWS} rows**, then upload via:\n` +
              '`/la-list multiadd action:file file:<your.xlsx>`'
          )
          .setColor(0x5865f2)
          .addFields(
            {
              name: '✅ Required Columns',
              value: '`name` · `type` · `reason`',
              inline: true,
            },
            {
              name: '🔹 Optional Columns',
              value: '`raid` · `logs` · `image` · `scope`',
              inline: true,
            },
            {
              name: '💡 Tips',
              value: [
                '• Use the **dropdown** in the `type` and `scope` columns.',
                '• Delete the yellow **example row** before uploading.',
                '• See the *Instructions* sheet inside the file for full details.',
                '• Upload evidence images to Discord first, then paste the link.',
              ].join('\n'),
              inline: false,
            }
          )
          .setFooter({
            text: `Lost Ark Bot • Max ${MULTIADD_MAX_ROWS} rows • 1 MB file limit`,
          });

        await interaction.editReply({
          embeds: [templateEmbed],
          files: [attachment],
        });
      } catch (err) {
        console.error('[multiadd] Template generation failed:', err);
        await interaction.editReply({
          content: `❌ Failed to generate template: \`${err.message}\``,
        });
      }
      return;
    }

    if (action === 'file') {
      const file = interaction.options.getAttachment('file');

      // ----- Attachment checks (fast-fail before download) -----
      if (!file) {
        await interaction.reply({
          content: '❌ Attach an `.xlsx` file with `action:file`.',
          ephemeral: true,
        });
        return;
      }
      if (!file.name?.toLowerCase().endsWith('.xlsx')) {
        await interaction.reply({
          content: `❌ File must be \`.xlsx\` (got \`${file.name}\`).`,
          ephemeral: true,
        });
        return;
      }
      if (file.size > 1024 * 1024) {
        await interaction.reply({
          content: `❌ File too large: ${(file.size / 1024).toFixed(1)} KB (max 1 MB).`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply({ ephemeral: true });

      // ----- Download file from Discord CDN -----
      let buffer;
      try {
        const response = await fetch(file.url);
        if (!response.ok) {
          await interaction.editReply({
            content: `❌ Failed to download file: HTTP ${response.status}`,
          });
          return;
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        console.error('[multiadd] Download failed:', err);
        await interaction.editReply({
          content: `❌ Failed to download file: \`${err.message}\``,
        });
        return;
      }

      // ----- Parse file -----
      const parsed = await parseMultiaddFile(buffer);
      if (!parsed.ok) {
        await interaction.editReply({
          content: `❌ Parse failed: ${parsed.error}`,
        });
        return;
      }

      // ----- No valid rows: show errors only and bail -----
      if (parsed.rows.length === 0) {
        const errEmbed = new EmbedBuilder()
          .setTitle('❌ No Valid Rows Found')
          .setDescription(
            parsed.errors.length > 0
              ? parsed.errors.slice(0, 15).join('\n').slice(0, 4000)
              : 'The file appears to be empty or has no data rows.'
          )
          .setColor(0xed4245)
          .setFooter({ text: 'Fix the errors and re-upload.' });
        await interaction.editReply({ embeds: [errEmbed] });
        return;
      }

      // ----- Store in pending map with expiry -----
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

      // ----- Build preview embed -----
      const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');
      const previewLines = parsed.rows.slice(0, 20).map((r, i) => {
        const reasonShort = r.reason.length > 50 ? r.reason.slice(0, 47) + '...' : r.reason;
        const scopeTag = r.scope === 'server' ? ' `[S]`' : '';
        return `\`${String(i + 1).padStart(2, ' ')}.\` ${typeIcon(r.type)} **${r.name}**${scopeTag} — ${reasonShort}`;
      });
      if (parsed.rows.length > 20) {
        previewLines.push(`*... and ${parsed.rows.length - 20} more rows*`);
      }

      const previewEmbed = new EmbedBuilder()
        .setTitle(`📋 Bulk Add Preview — ${parsed.rows.length} valid row${parsed.rows.length === 1 ? '' : 's'}`)
        .setDescription(previewLines.join('\n').slice(0, 4000))
        .setColor(0x5865f2)
        .setFooter({
          text:
            parsed.errors.length > 0
              ? `${parsed.errors.length} error${parsed.errors.length === 1 ? '' : 's'} below. Expires in 5 minutes.`
              : 'Expires in 5 minutes.',
        })
        .setTimestamp();

      if (parsed.errors.length > 0) {
        const errText = parsed.errors.slice(0, 10).join('\n').slice(0, 1024);
        const suffix = parsed.errors.length > 10 ? `\n*... and ${parsed.errors.length - 10} more*` : '';
        previewEmbed.addFields({
          name: `⚠️ Validation Errors (${parsed.errors.length})`,
          value: (errText + suffix).slice(0, 1024),
        });
      }

      const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`multiadd_confirm:${requestId}`)
          .setLabel(`Confirm — Add ${parsed.rows.length}`)
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`multiadd_cancel:${requestId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('✖️')
      );

      await interaction.editReply({
        embeds: [previewEmbed],
        components: [confirmRow],
      });
      return;
    }

    await interaction.reply({
      content: `❌ Unknown action: \`${action}\`.`,
      ephemeral: true,
    });
  }
  async function handleMultiaddConfirmButton(interaction) {
    const [prefix, requestId] = interaction.customId.split(':');
    const pending = multiaddPending.get(requestId);

    if (!pending) {
      await interaction.update({
        content: '⚠️ Request expired or already processed.',
        embeds: [],
        components: [],
      });
      return;
    }

    // Only the original requester can confirm or cancel
    if (interaction.user.id !== pending.requesterId) {
      await interaction.reply({
        content: '❌ Only the original requester can use these buttons.',
        ephemeral: true,
      });
      return;
    }

    if (prefix === 'multiadd_cancel') {
      clearMultiaddPending(requestId);
      await interaction.update({
        content: '✖️ Bulk add cancelled. No entries were added.',
        embeds: [],
        components: [],
      });
      return;
    }

    if (prefix === 'multiadd_confirm') {
      // Delete from pending immediately to prevent double-click double-run
      clearMultiaddPending(requestId);

      // ========== Branch A: requester is officer/senior → execute directly ==========
      // Use the stricter isOfficerOrSenior (not isRequesterAutoApprover) so
      // MEMBER_APPROVER_IDS doesn't bypass bulk approval — matches README.
      if (isOfficerOrSenior(pending.requesterId)) {
        // Update preview to "processing" state before the (potentially long) loop
        await interaction.update({
          content: `⏳ Processing ${pending.rows.length} rows... (this may take up to ${Math.ceil(pending.rows.length * 0.7)}s)`,
          embeds: [],
          components: [],
        });

        // Optional progress update (every 5 rows OR on final row)
        const onProgress = async (current, total) => {
          // Skip unless this is a multiple-of-5 tick OR the final row
          if (current % 5 !== 0 && current !== total) return;
          try {
            await interaction.editReply({
              content: `⏳ Processing... ${current}/${total} rows done`,
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

        // Fire-and-forget bulk broadcast (1 embed for all)
        broadcastBulkAdd(results.added, {
          guildId: pending.guildId,
          requestedByDisplayName: pending.requesterDisplayName,
        }).catch((err) => console.warn('[multiadd] Bulk broadcast failed:', err.message));

        const summaryEmbed = buildBulkSummaryEmbed(results, pending);
        await interaction.editReply({
          content: null,
          embeds: [summaryEmbed],
          components: [],
        });
        return;
      }

      // ========== Branch B: member → create PendingApproval + DM seniors ==========
      //
      // Ordering matters for crash safety AND race safety:
      //   1. Look up target approvers (from env config)
      //   2. Create PendingApproval with approverIds = targetIds up front so
      //      any early click passes permission check
      //   3. Send DMs to approvers (some may fail if bot is blocked)
      //   4. If NO DM was delivered, delete the placeholder
      //   5. Otherwise, trim approverIds to only those who successfully
      //      received the DM (so rejected approvers can't click non-existent
      //      buttons) and attach DM message refs
      try {
        await connectDB();

        // Senior-only recipient list for bulk approval. Must match what
        // sendBulkApprovalToApprovers uses, otherwise placeholder approverIds
        // would diverge from the actual DM recipients.
        const targetApproverIds = getSeniorApproverIds();
        if (targetApproverIds.length === 0) {
          await interaction.update({
            content: '⚠️ Failed to send approval request: No Senior approver user IDs configured. Set SENIOR_APPROVER_IDS in env.',
            embeds: [],
            components: [],
          });
          return;
        }

        const guild = interaction.guild || (await client.guilds.fetch(pending.guildId).catch(() => null));

        // Rehost row images NOW (at submit time, while user URLs are still
        // valid) so the approval flow does not need to re-download URLs that
        // may have already expired by the time Senior approves the batch.
        // Sequential with 200ms throttle to avoid hammering Discord upload
        // API. 30 rows × ~700ms ≈ 21s, well within 15-min interaction window.
        const rehostedRows = [];
        for (let i = 0; i < pending.rows.length; i++) {
          const r = pending.rows[i];
          let rehost = null;
          if (r.image) {
            rehost = await rehostImage(r.image, client, {
              entryName: r.name,
              addedBy: pending.requesterDisplayName || pending.requesterTag,
              listType: r.type,
            });
          }
          rehostedRows.push({
            ...r,
            _rehost: rehost, // attached for downstream use
          });
          if (i < pending.rows.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }

        // Build simplified bulkRows shape for DB (matches schema). Persist
        // rehost refs (imageMessageId/imageChannelId) so the approval flow
        // bypasses re-rehost when Senior approves later.
        const bulkRows = rehostedRows.map((r) => ({
          name: r.name,
          type: r.type,
          reason: r.reason,
          raid: r.raid || '',
          logsUrl: r.logs || '',
          imageUrl: r._rehost?.freshUrl || r.image || '',
          imageMessageId: r._rehost?.messageId || '',
          imageChannelId: r._rehost?.channelId || '',
          scope: r.scope || '',
        }));

        // Step 1+2: Create PendingApproval with the FULL target approver list
        // BEFORE sending DMs. This closes the race window where an approver
        // could click during step 3 (DM send) and fail permission check.
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
          approverIds: targetApproverIds, // preliminary — trimmed after DMs settle
          approverDmMessages: [],
        });

        // Step 3: Send DMs to approvers
        const approvalPending = {
          requestId,
          rows: pending.rows,
          requesterId: pending.requesterId,
          requesterTag: pending.requesterTag,
          requesterDisplayName: pending.requesterDisplayName,
          guildId: pending.guildId,
        };

        const sent = await sendBulkApprovalToApprovers(guild, approvalPending);

        // Step 4: If 0 deliveries, clean up placeholder
        if (!sent.success) {
          await PendingApproval.deleteOne({ requestId }).catch((err) =>
            console.warn('[multiadd] Failed to clean up placeholder approval:', err.message)
          );
          await interaction.update({
            content: `⚠️ Failed to send approval request: ${sent.reason}`,
            embeds: [],
            components: [],
          });
          return;
        }

        // Step 5: Trim approverIds to only those who actually received DM
        // and attach the DM message references for reject/cleanup flows.
        await PendingApproval.updateOne(
          { requestId },
          {
            $set: {
              approverIds: sent.deliveredApproverIds,
              approverDmMessages: sent.deliveredDmMessages,
            },
          }
        );

        const waitEmbed = new EmbedBuilder()
          .setTitle('⏳ Bulk Add — Awaiting Senior Approval')
          .setDescription(
            `Your bulk add of **${pending.rows.length} rows** has been sent to Senior for approval.\n\n` +
              `You'll be notified in this channel when the decision is made.`
          )
          .setColor(0xfee75c)
          .setFooter({ text: `Request ID: ${requestId.slice(0, 8)}` })
          .setTimestamp();

        await interaction.update({
          content: null,
          embeds: [waitEmbed],
          components: [],
        });
      } catch (err) {
        console.error('[multiadd] Approval request create failed:', err);
        // Best-effort cleanup of any placeholder left behind
        await PendingApproval.deleteOne({ requestId }).catch(() => {});
        await interaction.update({
          content: `❌ Failed to create approval request: \`${err.message}\``,
          embeds: [],
          components: [],
        }).catch(() => {});
      }
      return;
    }
  }
  async function handleMultiaddApprovalButton(interaction) {
    const [prefix, requestId] = interaction.customId.split(':');
    await connectDB();

    // Atomic claim: findOneAndDelete returns the document iff it still exists
    // AND the user is in the approverIds list. If two approvers click
    // simultaneously, exactly one gets the payload and the other gets null
    // — preventing double execution of the bulk add.
    const payload = await PendingApproval.findOneAndDelete({
      requestId,
      action: 'bulk',
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      // Distinguish "not authorized" vs "already processed / expired"
      const stillExists = await PendingApproval.exists({ requestId, action: 'bulk' });
      if (stillExists) {
        await interaction.reply({
          content: '⛔ You are not allowed to approve/reject this request.',
          ephemeral: true,
        });
      } else {
        await interaction.update({
          content: '⚠️ This bulk approval request has already been processed or expired.',
          embeds: [],
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
      // Update DM to show rejection decision
      const rejectEmbed = new EmbedBuilder()
        .setTitle('✖️ Bulk Add Rejected')
        .setDescription(`Rejected by <@${interaction.user.id}>`)
        .setColor(0xed4245)
        .setTimestamp();

      await interaction.update({
        embeds: [rejectEmbed],
        components: [],
      }).catch(() => {});

      // Sync the OTHER approvers' DMs so their buttons disappear too.
      // Excludes this interaction's message (already updated via .update() above).
      await syncApproverDmMessages(
        payload,
        { embeds: [rejectEmbed], components: [] },
        { excludeMessageId: interaction.message?.id || '' }
      ).catch((err) => console.warn('[multiadd] DM sync failed:', err.message));

      // Notify requester in origin channel
      try {
        const guild = await client.guilds.fetch(payload.guildId);
        const channel = await guild.channels.fetch(payload.channelId);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `<@${payload.requestedByUserId}> ❌ Your bulk add of **${payload.bulkRows.length} rows** was rejected by Senior.`,
          });
        }
      } catch (err) {
        console.warn('[multiadd] Failed to notify requester of rejection:', err.message);
      }
      return;
    }

    if (prefix === 'multiaddapprove_approve') {
      // Acknowledge immediately (execution can take 10-30s for 30 rows)
      await interaction.update({
        content: `⏳ Approved. Processing ${payload.bulkRows.length} rows...`,
        embeds: [],
        components: [],
      }).catch(() => {});

      // Re-hydrate rows from DB shape back to parser row shape (logs/image field names differ).
      // Carry rehost refs so executeBulkMultiadd can skip re-rehost (already done at submit time).
      const rows = payload.bulkRows.map((r) => ({
        name: r.name,
        type: r.type,
        reason: r.reason,
        raid: r.raid || '',
        logs: r.logsUrl || '',
        image: r.imageUrl || '',
        imageMessageId: r.imageMessageId || '',
        imageChannelId: r.imageChannelId || '',
        scope: r.scope || '',
        rowNum: 0,
      }));

      const results = await executeBulkMultiadd(rows, meta, null);

      // Fire-and-forget bulk broadcast
      broadcastBulkAdd(results.added, {
        guildId: payload.guildId,
        requestedByDisplayName: payload.requestedByDisplayName,
      }).catch((err) => console.warn('[multiadd] Bulk broadcast failed:', err.message));

      const summaryEmbed = buildBulkSummaryEmbed(results, meta);
      // Add approver info to the summary for the DM
      summaryEmbed.addFields({
        name: 'Approved by',
        value: `<@${interaction.user.id}>`,
        inline: false,
      });

      // Update approver DM with the summary
      await interaction.editReply({
        content: null,
        embeds: [summaryEmbed],
        components: [],
      }).catch(() => {});

      // Sync the OTHER approvers' DMs so their buttons disappear too.
      // Excludes this interaction's message (already updated via editReply above).
      await syncApproverDmMessages(
        payload,
        { embeds: [summaryEmbed], components: [] },
        { excludeMessageId: interaction.message?.id || '' }
      ).catch((err) => console.warn('[multiadd] DM sync failed:', err.message));

      // Notify requester in origin channel
      try {
        const guild = await client.guilds.fetch(payload.guildId);
        const channel = await guild.channels.fetch(payload.channelId);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `<@${payload.requestedByUserId}> ✅ Your bulk add was approved by Senior.`,
            embeds: [summaryEmbed],
          });
        }
      } catch (err) {
        console.warn('[multiadd] Failed to notify requester of approval:', err.message);
      }
      return;
    }
  }

  return {
    handleListMultiaddCommand,
    handleMultiaddConfirmButton,
    handleMultiaddApprovalButton,
  };
}
