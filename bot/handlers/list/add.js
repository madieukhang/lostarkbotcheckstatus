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

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import GuildConfig from '../../models/GuildConfig.js';
import PendingApproval from '../../models/PendingApproval.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
  detectAltsViaStronghold,
} from '../../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../services/listCheckService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../utils/imageRehost.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../../services/multiaddTemplateService.js';
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
} from './helpers.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;

export function createAddHandlers({ client, services }) {
  const {
    sendListAddApprovalToApprovers,
    syncApproverDmMessages,
    executeListAddToDatabase,
    broadcastListChange,
    notifyRequesterAboutDecision,
  } = services;

  async function handleListAddApprovalButton(interaction) {
    const customParts = interaction.customId.split(':');
    const action = customParts[0];
    const requestId = customParts[1];
    await connectDB();

    // Find but don't delete yet — need to keep for duplicate overwrite flow
    const payload = await PendingApproval.findOne({
      requestId,
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId });

      if (stillExists) {
        await interaction.reply({
          content: '⛔ You are not allowed to approve/reject this request.',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: '⚠️ This approval request was already processed or has expired.',
        ephemeral: true,
      });
      return;
    }

    const isApproveAction = action === 'listadd_approve';

    // Acknowledge immediately, then show processing state to avoid 3s timeout issues.
    await interaction.deferUpdate();

    await interaction.editReply({
      content: isApproveAction
        ? `⏳ Processing approval by **${interaction.user.tag}**...`
        : `⏳ Processing rejection by **${interaction.user.tag}**...`,
      components: [buildApprovalProcessingRow(action)],
    });

    await syncApproverDmMessages(
      payload,
      {
        content: isApproveAction
          ? `⏳ Processing approval by **${interaction.user.tag}**...`
          : `⏳ Processing rejection by **${interaction.user.tag}**...`,
        components: [buildApprovalProcessingRow(action)],
      },
      { excludeMessageId: interaction.message.id }
    );

    if (!isApproveAction) {
      await PendingApproval.deleteOne({ requestId });

      await interaction.editReply({
        content: `❌ Rejected by **${interaction.user.tag}**`,
        components: [buildApprovalResultRow('Rejected')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `❌ Rejected by **${interaction.user.tag}**`,
          components: [buildApprovalResultRow('Rejected')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    try {
      // Edit approval — update/move existing entry by _id (not add new)
      if (payload.action === 'edit' && payload.existingEntryId) {
        const { model: oldModel } = getListContext(payload.currentType || payload.type);
        const { model: newModel, label: newLabel, icon: newIcon } = getListContext(payload.type);
        const isTypeChange = payload.currentType && payload.currentType !== payload.type;

        const existingEntry = await oldModel.findById(payload.existingEntryId);
        if (!existingEntry) {
          await PendingApproval.deleteOne({ requestId });
          await interaction.editReply({
            content: `⚠️ Original entry no longer exists — it may have been removed.`,
            components: [buildApprovalResultRow('Failed')],
          });
          return;
        }

        // Captured per-branch for the rich success embed below.
        let postEditEntry = null;

        if (isTypeChange) {
          // Preflight: scope-aware duplicate check on target list
          const nameMatch = { $or: [{ name: existingEntry.name }, { allCharacters: existingEntry.name }] };
          let preflightQuery;
          if (payload.type === 'black') {
            preflightQuery = { $and: [nameMatch, { $or: [
              { scope: 'global' },
              { scope: { $exists: false } },
              { scope: 'server', guildId: payload.guildId || '' },
            ] }] };
          } else {
            preflightQuery = nameMatch;
          }
          const targetDupe = await newModel.findOne(preflightQuery)
            .collation({ locale: 'en', strength: 2 }).lean();
          if (targetDupe) {
            await PendingApproval.deleteOne({ requestId });
            await interaction.editReply({
              content: `⚠️ **${existingEntry.name}** already exists in target list. Edit aborted.`,
              components: [buildApprovalResultRow('Failed')],
            });
            return;
          }

          // Recheck trusted guard at approval time (status may have changed)
          {
            const trustedNow = await TrustedUser.findOne({
              $or: [{ name: existingEntry.name }, ...(existingEntry.allCharacters?.length > 0 ? [{ name: { $in: existingEntry.allCharacters } }] : [])],
            }).collation({ locale: 'en', strength: 2 }).lean();
            if (trustedNow) {
              await PendingApproval.deleteOne({ requestId });
              await interaction.editReply({
                content: `🛡️ **${existingEntry.name}** is now a trusted user — cannot be added to any list.`,
                embeds: [buildTrustedBlockEmbed(existingEntry.name, trustedNow.reason)],
                components: [buildApprovalResultRow('Blocked')],
              });
              return;
            }
          }

          // Image fields: prefer new rehost from payload, fall back to existing
          // entry's rehost refs, then legacy URL. This preserves rehost
          // permanence across cross-list moves and avoids regressing rehosted
          // entries into expiring URLs.
          const moveImageMessageId = payload.imageMessageId || existingEntry.imageMessageId || '';
          const moveImageChannelId = payload.imageChannelId || existingEntry.imageChannelId || '';
          const moveImageUrl = moveImageMessageId
            ? '' // rehosted entries do not store legacy URL
            : (payload.imageUrl || existingEntry.imageUrl || '');

          // Create first, then delete old (safe order — if create fails, old preserved)
          postEditEntry = await newModel.create({
            name: existingEntry.name,
            reason: payload.reason || existingEntry.reason,
            raid: payload.raid || existingEntry.raid,
            logsUrl: payload.logsUrl || existingEntry.logsUrl,
            imageUrl: moveImageUrl,
            imageMessageId: moveImageMessageId,
            imageChannelId: moveImageChannelId,
            allCharacters: existingEntry.allCharacters || [],
            addedByUserId: existingEntry.addedByUserId,
            addedByTag: existingEntry.addedByTag,
            addedByDisplayName: existingEntry.addedByDisplayName,
            addedAt: existingEntry.addedAt,
            ...(payload.type === 'black' ? { scope: payload.scope || existingEntry.scope || 'global', guildId: (payload.scope || existingEntry.scope || 'global') === 'server' ? (payload.guildId || '') : '' } : {}),
          });
          await oldModel.deleteOne({ _id: existingEntry._id });
        } else {
          const updateFields = {};
          if (payload.reason && payload.reason !== existingEntry.reason) updateFields.reason = payload.reason;
          if (payload.raid && payload.raid !== existingEntry.raid) updateFields.raid = payload.raid;
          if (payload.logsUrl && payload.logsUrl !== existingEntry.logsUrl) updateFields.logsUrl = payload.logsUrl;
          // Image update is atomic across all 3 fields: if a new rehosted
          // image was provided, replace all 3; if a new legacy URL only,
          // replace all 3 to clear stale rehost refs; otherwise leave alone.
          if (payload.imageMessageId && payload.imageMessageId !== existingEntry.imageMessageId) {
            updateFields.imageUrl = '';
            updateFields.imageMessageId = payload.imageMessageId;
            updateFields.imageChannelId = payload.imageChannelId || '';
          } else if (payload.imageUrl && !payload.imageMessageId && payload.imageUrl !== existingEntry.imageUrl) {
            updateFields.imageUrl = payload.imageUrl;
            updateFields.imageMessageId = '';
            updateFields.imageChannelId = '';
          }
          // Scope change in place — only blacklist supports it. Approval flow
          // only reaches this branch when payload.type === existingEntry's
          // current type (no cross-list move), so checking type === 'black'
          // is enough.
          if (
            payload.type === 'black'
            && payload.scope
            && payload.scope !== (existingEntry.scope || 'global')
          ) {
            updateFields.scope = payload.scope;
            updateFields.guildId = payload.scope === 'server' ? (payload.guildId || '') : '';
          }
          if (Object.keys(updateFields).length > 0) {
            try {
              await oldModel.updateOne({ _id: existingEntry._id }, { $set: updateFields });
            } catch (err) {
              // Defense in depth for the unique index race on scope change
              if (err.code === 11000 && updateFields.scope) {
                await PendingApproval.deleteOne({ requestId });
                await interaction.editReply({
                  content: `⚠️ Cannot apply scope change: another entry with this name already occupies the target scope. Approval aborted.`,
                  components: [buildApprovalResultRow('Failed')],
                });
                return;
              }
              throw err;
            }
          }
          // Capture for the rich success embed below — virtual post-edit
          // entry is the pre-edit snapshot merged with updateFields.
          postEditEntry = { ...(existingEntry.toObject?.() || existingEntry), ...updateFields };
        }

        // Broadcast edit: routing decided by the FINAL scope (after any scope
        // change applied above). Using payload.scope first ensures that a
        // demote-to-local edit broadcasts only to owner, and a promote-to-global
        // edit broadcasts to all opted-in servers.
        const broadcastScope = payload.scope || existingEntry.scope || 'global';
        broadcastListChange('edited', { ...existingEntry.toObject?.() || existingEntry, reason: payload.reason || existingEntry.reason, raid: payload.raid || existingEntry.raid, scope: broadcastScope }, {
          type: payload.type,
          guildId: payload.guildId,
          requestedByDisplayName: payload.requestedByDisplayName,
          requestedByTag: payload.requestedByTag,
        }, { onlyOwner: broadcastScope === 'server' }).catch(() => {});

        await PendingApproval.deleteOne({ requestId });

        // Derive changes summary by comparing payload to the pre-edit snapshot.
        // The original /list edit command's `changes` array doesn't survive
        // the PendingApproval round trip, so we reconstruct it here for the
        // rich success embed.
        const approvalChanges = [];
        if (payload.reason && payload.reason !== existingEntry.reason) {
          approvalChanges.push(`Reason: "${existingEntry.reason || ''}" → "${payload.reason}"`);
        }
        if (isTypeChange) {
          const oldLabel = getListContext(payload.currentType).label;
          approvalChanges.push(`List: ${oldLabel} → ${newLabel}`);
        }
        if (payload.raid && payload.raid !== existingEntry.raid) {
          approvalChanges.push(`Raid: "${existingEntry.raid || 'N/A'}" → "${payload.raid}"`);
        }
        if (payload.logsUrl && payload.logsUrl !== (existingEntry.logsUrl || '')) {
          approvalChanges.push('Logs: updated');
        }
        const evidenceChanged =
          (payload.imageMessageId && payload.imageMessageId !== existingEntry.imageMessageId)
          || (payload.imageUrl && !payload.imageMessageId && payload.imageUrl !== existingEntry.imageUrl);
        if (evidenceChanged) {
          approvalChanges.push('Evidence: updated');
        }
        if (
          payload.type === 'black'
          && payload.scope
          && payload.scope !== (existingEntry.scope || 'global')
        ) {
          approvalChanges.push(`Scope: ${existingEntry.scope || 'global'} → ${payload.scope}`);
        }

        // Build the rich success embed for the requester reply. Falls back
        // to plain text if postEditEntry is somehow null (shouldn't happen
        // but defensive — null embeds[] is handled by notifyRequester).
        let approvalSuccessEmbed = null;
        if (postEditEntry) {
          const entryForEmbed = postEditEntry.toObject?.() || postEditEntry;
          const approvalFreshUrl = await resolveDisplayImageUrl(entryForEmbed, client);
          approvalSuccessEmbed = buildListEditSuccessEmbed(entryForEmbed, {
            changes: approvalChanges,
            type: payload.type,
            freshDisplayUrl: approvalFreshUrl,
            requesterDisplayName: payload.requestedByDisplayName || payload.requestedByTag || 'Unknown',
            isMove: isTypeChange,
          });
        }

        const editResult = {
          ok: true,
          content: `✅ Edit approved: **${existingEntry.name}**${isTypeChange ? ` moved to ${newLabel}` : ' updated'}.`,
          embeds: approvalSuccessEmbed ? [approvalSuccessEmbed] : [],
        };

        await interaction.editReply({
          content: `✅ Edit approved by **${interaction.user.tag}**.`,
          components: [buildApprovalResultRow('Approved')],
        });
        await syncApproverDmMessages(payload, {
          content: `✅ Edit approved by **${interaction.user.tag}**.`,
          components: [buildApprovalResultRow('Approved')],
        }, { excludeMessageId: interaction.message.id });
        await notifyRequesterAboutDecision(payload, editResult, false);
        return;
      }

      const result = await executeListAddToDatabase(payload);

      // Duplicate found — show comparison and overwrite option
      if (!result.ok && result.isDuplicate) {
        const existing = result.existingEntry;
        const { label } = getListContext(payload.type);

        // Save duplicate entry _id for scope-safe deletion during overwrite
        await PendingApproval.updateOne(
          { requestId },
          { $set: { duplicateEntryId: String(existing._id) } }
        );

        const existingScopeTag = existing.scope === 'server' ? ' [Server]' : ' [Global]';
        const requestScopeTag = payload.scope === 'server' ? ' [Server]' : ' [Global]';
        const compareEmbed = new EmbedBuilder()
          .setTitle('⚠️ Duplicate Found — Compare')
          .addFields(
            { name: `📌 Existing Entry${existingScopeTag}`, value: `**${existing.name}**\nReason: ${existing.reason || 'N/A'}\nRaid: ${existing.raid || 'N/A'}\nAdded: <t:${Math.floor(new Date(existing.addedAt || 0).getTime() / 1000)}:R>`, inline: true },
            { name: `🆕 New Request${requestScopeTag}`, value: `**${payload.name}**\nReason: ${payload.reason || 'N/A'}\nRaid: ${payload.raid || 'N/A'}\nBy: ${payload.requestedByDisplayName || 'Unknown'}`, inline: true },
          )
          .setColor(0xfee75c);

        const overwriteRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`listadd_overwrite:${requestId}`)
            .setLabel('Overwrite')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`listadd_keep:${requestId}`)
            .setLabel('Keep Existing')
            .setStyle(ButtonStyle.Secondary),
        );

        await interaction.editReply({
          content: `⚠️ **${payload.name}** already in ${label}. Overwrite or keep?`,
          embeds: [compareEmbed],
          components: [overwriteRow],
        });

        await syncApproverDmMessages(
          payload,
          {
            content: `⚠️ **${payload.name}** already in ${label}. Overwrite or keep?`,
            embeds: [compareEmbed],
            components: [overwriteRow],
          },
          { excludeMessageId: interaction.message.id }
        );
        // Don't delete PendingApproval — needed for overwrite flow
        return;
      }

      // Success or non-duplicate error — clean up
      await PendingApproval.deleteOne({ requestId });

      await interaction.editReply({
        content: result.ok
          ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
          : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: result.ok
            ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
            : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
          components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, result, false);
    } catch (err) {
      await PendingApproval.deleteOne({ requestId });

      await interaction.editReply({
        content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
        components: [buildApprovalResultRow('Failed')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
          components: [buildApprovalResultRow('Failed')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(
        payload,
        { content: `⚠️ Failed to execute approved request: \`${err.message}\``, embeds: [] },
        false
      );
    }
  }

  async function handleListAddViewEvidenceButton(interaction) {
    const requestId = interaction.customId.split(':')[1];
    await connectDB();

    // Restrict to assigned approvers only — same permission model as
    // Approve/Reject. Avoids leaking evidence images to non-approvers who
    // somehow get hold of the button (shouldn't happen, but defense in depth).
    const payload = await PendingApproval.findOne({
      requestId,
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId });
      if (stillExists) {
        await interaction.reply({
          content: '⛔ You are not allowed to view evidence for this request.',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: '⚠️ This approval request was already processed or has expired.',
          ephemeral: true,
        });
      }
      return;
    }

    // Resolve the freshest possible URL: rehost-aware first, legacy fallback.
    let freshUrl = null;
    let isLegacy = false;
    if (payload.imageMessageId && payload.imageChannelId) {
      freshUrl = await refreshImageUrl(payload.imageMessageId, payload.imageChannelId, client);
    }
    if (!freshUrl && payload.imageUrl) {
      freshUrl = payload.imageUrl;
      isLegacy = true;
    }

    if (!freshUrl) {
      await interaction.reply({
        content: '⚠️ No evidence image attached to this request, or the rehosted message was removed.',
        ephemeral: true,
      });
      return;
    }

    const evidenceEmbed = new EmbedBuilder()
      .setTitle(`📎 Evidence — ${payload.name}`)
      .setDescription(payload.reason ? `*${payload.reason}*` : null)
      .setImage(freshUrl)
      .setColor(payload.type === 'black' ? 0xed4245 : payload.type === 'white' ? 0x57f287 : 0xfee75c)
      .setFooter({
        text: isLegacy
          ? 'Legacy image (may have expired) — submitted before evidence rehost'
          : 'Fresh URL just resolved from evidence channel',
      })
      .setTimestamp(payload.createdAt ? new Date(payload.createdAt) : new Date());

    await interaction.reply({
      embeds: [evidenceEmbed],
      ephemeral: true,
    });
  }
  async function handleListAddCommand(interaction) {
    const type = interaction.options.getString('type', true);
    const rawName = interaction.options.getString('name', true).trim();
    const reason = interaction.options.getString('reason', true).trim();
    const raid = interaction.options.getString('raid') ?? '';
    const logs = interaction.options.getString('logs') ?? '';
    const image = interaction.options.getAttachment('image');
    const inputScope = interaction.options.getString('scope') || '';
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    if (!interaction.guild) {
      await interaction.editReply({
        content: '❌ This command can only be used in a server.',
      });
      return;
    }

    // Resolve scope: explicit input > guild default setting > 'global'
    let scope = inputScope;
    if (!scope && type === 'black') {
      await connectDB();
      const guildConfig = await getGuildConfig(interaction.guild.id);
      scope = guildConfig?.defaultBlacklistScope || 'global';
    }
    if (!scope) scope = 'global'; // non-blacklist types always global

    if (!reason) {
      await interaction.editReply({
        content: '❌ Reason cannot be empty.',
      });
      return;
    }

    if (image?.contentType && !image.contentType.startsWith('image/')) {
      await interaction.editReply({
        content: '❌ Attachment must be an image file.',
      });
      return;
    }

    try {
      const requestId = randomUUID();

      // Rehost the image NOW (while the Discord CDN URL is still valid).
      // If rehost fails or no evidence channel is configured, we fall back to
      // storing the original URL as legacy (which will eventually expire).
      let rehostResult = null;
      if (image?.url) {
        rehostResult = await rehostImage(image.url, client, {
          entryName: name,
          addedBy: getInteractionDisplayName(interaction),
          listType: type,
        });
      }

      const payload = {
        requestId,
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        logsUrl: logs,
        // imageUrl carries the CURRENT display URL (fresh at this moment).
        // If rehosted, use the freshly-signed evidence URL; otherwise the
        // original attachment URL. Either way it's valid for immediate render.
        // executeListAddToDatabase decides whether to PERSIST this URL based
        // on whether imageMessageId is set (rehosted entries don't store URL).
        imageUrl: rehostResult?.freshUrl || image?.url || '',
        imageMessageId: rehostResult?.messageId || '',
        imageChannelId: rehostResult?.channelId || '',
        scope: type === 'black' ? scope : 'global', // scope only applies to blacklist
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: getInteractionDisplayName(interaction),
        createdAt: Date.now(),
      };

      // Auto-approve: officers always, OR server-scoped entries (local = no approval needed)
      if (isRequesterAutoApprover(payload.requestedByUserId) || payload.scope === 'server') {
        const result = await executeListAddToDatabase(payload);
        // Prefer rich embed when available; fall back to plain content for
        // simple success messages that don't need a structured alert.
        const hasEmbed = (result.embeds?.length ?? 0) > 0;
        await interaction.editReply({
          content: hasEmbed ? null : result.content,
          embeds: result.embeds ?? [],
        });
        return;
      }

      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({
          content: `⚠️ Failed to send approval request to approvers: ${sent.reason}`,
        });
        return;
      }

      await connectDB();
      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        embeds: [
          buildListAddApprovalEmbed(interaction.guild, payload, {
            title: 'List Add — Proposal Submitted',
            includeRequestedBy: false,
          }),
        ],
      });

      try {
        const requestReply = await interaction.fetchReply();
        await PendingApproval.updateOne(
          { requestId },
          { $set: { requestMessageId: requestReply.id } }
        );
      } catch (err) {
        console.warn('[list] Failed to capture request reply message ID:', err.message);
      }
    } catch (err) {
      console.error('[list] ❌ Proposal create/send failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to create approval request: \`${err.message}\``,
      });
    }
  }
  async function handleListAddOverwriteButton(interaction) {
    const [, requestId] = interaction.customId.split(':');
    const isOverwrite = interaction.customId.startsWith('listadd_overwrite:');

    await connectDB();
    const payload = await PendingApproval.findOneAndDelete({ requestId }).lean();

    if (!payload) {
      await interaction.reply({
        content: '⚠️ This request has already been processed or expired.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferUpdate();

    if (!isOverwrite) {
      // Keep existing — just clean up
      await interaction.editReply({
        content: `✅ Kept existing entry. New request for **${payload.name}** discarded.`,
        embeds: [],
        components: [buildApprovalResultRow('Kept Existing')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `✅ Kept existing entry. New request for **${payload.name}** discarded.`,
          embeds: [],
          components: [buildApprovalResultRow('Kept Existing')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    // Overwrite: update existing entry in-place (safe — no delete-then-add risk)
    try {
      const { model, label, icon } = getListContext(payload.type);

      // Find the duplicate entry to update
      let dupeEntry;
      if (payload.duplicateEntryId) {
        dupeEntry = await model.findById(payload.duplicateEntryId);
      }
      if (!dupeEntry) {
        // Fallback: scope-aware find
        const name = normalizeCharacterName(payload.name);
        const nameMatch = { $or: [{ name }, { allCharacters: name }] };
        if (payload.type === 'black') {
          const entryScope = payload.scope || 'global';
          const scopeMatch = entryScope === 'server'
            ? { scope: 'server', guildId: payload.guildId || '' }
            : { $or: [{ scope: 'global' }, { scope: { $exists: false } }] };
          dupeEntry = await model.findOne({ $and: [nameMatch, scopeMatch] }).collation({ locale: 'en', strength: 2 });
        } else {
          dupeEntry = await model.findOne(nameMatch).collation({ locale: 'en', strength: 2 });
        }
      }

      if (!dupeEntry) {
        await interaction.editReply({
          content: '⚠️ Original entry no longer exists — it may have been removed.',
          embeds: [],
          components: [buildApprovalResultRow('Failed')],
        });
        return;
      }

      // Update in-place: overwrite fields + refresh roster for new canonical name
      const newName = normalizeCharacterName(payload.name);
      const rosterResult = await buildRosterCharacters(newName, {
        hiddenRosterFallback: true,
      }).catch(() => null);

      dupeEntry.name = newName;
      // Only update roster if fetch succeeded — preserve old snapshot on failure
      if (rosterResult?.hasValidRoster && rosterResult.allCharacters?.length > 0) {
        dupeEntry.allCharacters = rosterResult.allCharacters;
      }
      dupeEntry.reason = payload.reason || dupeEntry.reason;
      dupeEntry.raid = payload.raid || dupeEntry.raid;
      dupeEntry.logsUrl = payload.logsUrl || dupeEntry.logsUrl;
      // Image overwrite: prefer new rehost refs, fall back to new legacy URL,
      // else preserve existing entry's image fields entirely.
      if (payload.imageMessageId) {
        dupeEntry.imageUrl = '';
        dupeEntry.imageMessageId = payload.imageMessageId;
        dupeEntry.imageChannelId = payload.imageChannelId || '';
      } else if (payload.imageUrl) {
        dupeEntry.imageUrl = payload.imageUrl;
        dupeEntry.imageMessageId = '';
        dupeEntry.imageChannelId = '';
      }
      // Preserve existing scope — overwrite should not change global↔server
      // (scope is a structural property, not metadata)
      dupeEntry.addedByUserId = payload.requestedByUserId;
      dupeEntry.addedByTag = payload.requestedByTag;
      dupeEntry.addedByName = payload.requestedByName;
      dupeEntry.addedByDisplayName = payload.requestedByDisplayName;
      dupeEntry.addedAt = new Date();
      await dupeEntry.save();

      console.log(`[list] Overwrite: updated ${payload.type} entry for ${dupeEntry.name} in-place`);

      const resultMsg = `✅ Overwritten by **${interaction.user.tag}**. Entry updated.`;
      await interaction.editReply({
        content: resultMsg,
        embeds: [],
        components: [buildApprovalResultRow('Overwritten')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: resultMsg,
          embeds: [],
          components: [buildApprovalResultRow('Overwritten')],
        },
        { excludeMessageId: interaction.message.id }
      );

      // Broadcast overwrite: global to all, server-scoped to owner only
      broadcastListChange('edited', dupeEntry, {
        type: payload.type,
        guildId: payload.guildId,
        requestedByDisplayName: payload.requestedByDisplayName,
        requestedByTag: payload.requestedByTag,
      }, { onlyOwner: dupeEntry.scope === 'server' }).catch(() => {});

      await notifyRequesterAboutDecision(payload, { ok: true, content: resultMsg }, false);
    } catch (err) {
      console.error('[list] Overwrite failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Overwrite failed: \`${err.message}\``,
        embeds: [],
        components: [buildApprovalResultRow('Failed')],
      });
    }
  }

  return {
    handleListAddCommand,
    handleListAddApprovalButton,
    handleListAddViewEvidenceButton,
    handleListAddOverwriteButton,
  };
}
