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
  parseAdditionalNames,
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

export function createEditHandlers({ client, services }) {
  const { sendListAddApprovalToApprovers, broadcastListChange } = services;

  async function handleListEditCommand(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const raw = interaction.options.getString('name');
    const name = normalizeCharacterName(raw);
    const newReason = interaction.options.getString('reason')?.trim() || '';
    const newType = interaction.options.getString('type') || '';
    const newRaid = interaction.options.getString('raid')?.trim() || '';
    const newLogs = interaction.options.getString('logs')?.trim() || '';
    const imageAttachment = interaction.options.getAttachment('image');
    const newImageUrl = imageAttachment?.url || '';
    // Optional scope override — only valid for blacklist entries (validated below).
    const newScopeRaw = interaction.options.getString('scope') || '';
    const newScope = newScopeRaw === 'global' || newScopeRaw === 'server' ? newScopeRaw : '';
    // Manual alt append: officer/senior or entry owner only. Designed to
    // fill the gap where /la-list enrich cant run (target has hidden
    // roster AND no guild = no candidate pool to walk).
    const additionalNamesRaw = interaction.options.getString('additional_names') || '';

    // Defer FIRST so the rehost (download + upload, can take 1-3s) does not
    // cross Discord's 3-second interaction ack window. Discord keeps the
    // attachment URL valid through the deferred state, so rehost can still
    // download it after the defer.
    await interaction.deferReply();
    await connectDB();

    // Rehost the new image NOW (while CDN URL is still valid). Result is used
    // later in updateFields. If rehost fails or no evidence channel configured,
    // we fall back to storing the legacy URL (which will eventually expire).
    let newImageRehost = null;
    if (newImageUrl) {
      newImageRehost = await rehostImage(newImageUrl, client, {
        entryName: name,
        addedBy: getInteractionDisplayName(interaction),
        listType: '', // type may change in this edit; leave blank
      });
    }

    // Find existing entry across all lists (scope-aware for blacklist)
    const collation = { locale: 'en', strength: 2 };
    const query = { $or: [{ name }, { allCharacters: name }] };
    const editGuildId = interaction.guild.id;
    const editGuildConfig = await getGuildConfig(editGuildId);
    const editGuildDefaultScope = editGuildConfig?.defaultBlacklistScope || 'global';

    const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
      Blacklist.findOne(buildBlacklistQuery(query, editGuildId)).sort({ scope: -1 }).collation(collation),
      Whitelist.findOne(query).collation(collation),
      Watchlist.findOne(query).collation(collation),
    ]);

    const existing = blackEntry || whiteEntry || watchEntry;
    if (!existing) {
      await interaction.editReply({ content: `❌ **${name}** not found in any list.` });
      return;
    }

    const currentType = blackEntry ? 'black' : whiteEntry ? 'white' : 'watch';
    const { label: currentLabel } = getListContext(currentType);

    // Permission gate for additional_names: officer/senior or entry
    // owner only. The approval flow used for member edits does not
    // carry allCharacters changes through to the apply step, so reject
    // up front rather than silently dropping the option.
    if (additionalNamesRaw) {
      const isOwnerForAdd = existing.addedByUserId === interaction.user.id;
      const isApproverForAdd = isOfficerOrSenior(interaction.user.id);
      if (!isOwnerForAdd && !isApproverForAdd) {
        await interaction.editReply({
          content: '🛡️ The `additional_names` option is officer-only (or the entry owner). Ask an officer to append the alts for you.',
        });
        return;
      }
    }

    const additionalNamesParsed = parseAdditionalNames(
      additionalNamesRaw,
      existing.allCharacters || [],
      existing.name
    );

    // Check if anything is actually changing
    if (!newReason && !newType && !newRaid && !newLogs && !newImageUrl && !newScope && !additionalNamesRaw) {
      await interaction.editReply({ content: `⚠️ No changes provided. Use options to specify what to edit.` });
      return;
    }

    const targetType = newType || currentType;
    const isTypeChange = targetType !== currentType;

    // Scope option validation: only meaningful for blacklist entries.
    // White/watch lists are always global by design — reject scope on non-blacklist
    // edits with a clear error rather than silently ignoring.
    if (newScope && targetType !== 'black') {
      await interaction.editReply({
        content: `⚠️ The \`scope\` option only applies to blacklist entries. ${targetType === 'white' ? 'Whitelist' : 'Watchlist'} entries are always global.`,
      });
      return;
    }

    // Resolve target scope:
    //   - If user provided scope option → use it
    //   - Else if currently blacklist (no type change) → keep existing scope
    //   - Else if moving INTO blacklist → use guild default scope
    //   - Else (white/watch) → always 'global' (scope field unused there)
    const existingObjForScope = existing.toObject?.() || existing;
    const targetScope = targetType === 'black'
      ? (newScope || existingObjForScope.scope || editGuildDefaultScope)
      : 'global';

    // Detect actual scope change (only meaningful for blacklist→blacklist edits).
    // Cross-list moves carry their own scope handling in the move branch.
    const isScopeChange = !isTypeChange
      && currentType === 'black'
      && targetScope !== (existingObjForScope.scope || 'global');

    // Conflict detection for in-place scope change: would the new
    // {name, scope, guildId} combination collide with an existing entry?
    if (isScopeChange) {
      const newGuildId = targetScope === 'server' ? editGuildId : '';
      const conflictQuery = {
        name: existing.name,
        scope: targetScope,
        ...(targetScope === 'server' ? { guildId: newGuildId } : {}),
        _id: { $ne: existing._id },
      };
      const conflict = await Blacklist.findOne(conflictQuery)
        .collation(collation)
        .lean();
      if (conflict) {
        const conflictDesc = targetScope === 'global'
          ? 'a global blacklist entry with this name already exists'
          : 'a server-scoped blacklist entry with this name already exists in this server';
        await interaction.editReply({
          content: `⚠️ Cannot change scope: ${conflictDesc}. Remove the conflicting entry first, or merge them manually.`,
        });
        return;
      }
    }

    // Build changes summary
    const changes = [];
    if (newReason) changes.push(`Reason: "${existing.reason}" → "${newReason}"`);
    if (isTypeChange) changes.push(`List: ${currentLabel} → ${getListContext(targetType).label}`);
    if (newRaid) changes.push(`Raid: "${existing.raid || 'N/A'}" → "${newRaid}"`);
    if (newLogs) changes.push(`Logs: updated`);
    if (newImageUrl) changes.push(`Evidence: updated`);
    if (isScopeChange) changes.push(`Scope: ${existingObjForScope.scope || 'global'} → ${targetScope}`);
    if (additionalNamesParsed.added.length > 0) {
      const line = additionalNamesParsed.duplicates.length > 0
        ? `Append alts: ${additionalNamesParsed.added.join(', ')} (skipped duplicates: ${additionalNamesParsed.duplicates.join(', ')})`
        : `Append alts: ${additionalNamesParsed.added.join(', ')}`;
      changes.push(line);
    }

    // Catch the no-op case: user provided scope option but it matches the
    // existing scope, and no other fields are being changed. Rejecting here
    // keeps the success message honest (otherwise it'd say "edited" with an
    // empty change list).
    if (changes.length === 0) {
      await interaction.editReply({
        content: '⚠️ No effective changes — the provided values already match the current entry.',
      });
      return;
    }

    // Trusted user guard: block adding/moving trusted users to any list
    if (isTypeChange) {
      const trustedCheck = await TrustedUser.findOne({
        $or: [
          { name: existing.name },
          ...(existing.allCharacters?.length > 0 ? [{ name: { $in: existing.allCharacters } }] : []),
        ],
      }).collation({ locale: 'en', strength: 2 }).lean();
      if (trustedCheck) {
        const isSelf = trustedCheck.name.toLowerCase() === existing.name.toLowerCase();
        await interaction.editReply({
          content: `🛡️ **${existing.name}** is a trusted user and cannot be moved to any list.`,
          embeds: [buildTrustedBlockEmbed(existing.name, trustedCheck.reason, isSelf ? {} : { via: trustedCheck.name })],
        });
        return;
      }
    }

    // Check ownership: same person → apply now, different → approval
    // Auto-approve rule (final-state aware): if the FINAL state of this edit
    // results in a server-scoped blacklist entry, auto-approve. This means:
    //   - Demoting global → server: auto-approves (de-escalation, harmless)
    //   - Promoting server → global: requires approval (privilege escalation)
    //   - Editing fields on a local entry without changing scope: auto-approves
    //   - Moving white/watch → black with default scope=server: auto-approves
    // White/watch have no scope concept — they never auto-approve via this rule.
    const isOwner = existing.addedByUserId === interaction.user.id;
    const isApprover = isRequesterAutoApprover(interaction.user.id);
    const existingObj = existing.toObject?.() || existing;
    const isLocalScope = targetType === 'black' && targetScope === 'server';

    if (isOwner || isApprover || isLocalScope) {
      // Apply edit immediately
      try {
        if (isTypeChange) {
          // Move to different list: preflight duplicate check, then delete old + create new
          const { model: oldModel } = getListContext(currentType);
          const { model: newModel, label: newLabel, icon: newIcon } = getListContext(targetType);

          // Preflight: scope-aware duplicate check on target list
          const nameMatch = { $or: [{ name: existing.name }, { allCharacters: existing.name }] };
          let preflightQuery;
          if (targetType === 'black') {
            // Blacklist: only check global + own server entries (same as /list add)
            preflightQuery = { $and: [nameMatch, { $or: [
              { scope: 'global' },
              { scope: { $exists: false } },
              { scope: 'server', guildId: editGuildId },
            ] }] };
          } else {
            preflightQuery = nameMatch;
          }
          const targetDupe = await newModel.findOne(preflightQuery)
            .collation({ locale: 'en', strength: 2 }).lean();
          if (targetDupe) {
            await interaction.editReply({
              content: `⚠️ **${existing.name}** already exists in ${newLabel}. Remove it first before moving.`,
            });
            return;
          }

          // Safe to move: create first, then delete old (if create fails, old entry preserved)
          const existingObj = existing.toObject?.() || existing;
          // Image inheritance: if user provided a new image AND it was rehosted,
          // use the rehost refs; if new image but rehost failed, use legacy URL;
          // if no new image, carry over the existing entry's image fields.
          const moveImageFields = newImageUrl
            ? (newImageRehost
                ? { imageUrl: '', imageMessageId: newImageRehost.messageId, imageChannelId: newImageRehost.channelId }
                : { imageUrl: newImageUrl, imageMessageId: '', imageChannelId: '' })
            : { imageUrl: existing.imageUrl || '', imageMessageId: existing.imageMessageId || '', imageChannelId: existing.imageChannelId || '' };

          const movedEntry = await newModel.create({
            name: existing.name,
            reason: newReason || existing.reason,
            raid: newRaid || existing.raid,
            logsUrl: newLogs || existing.logsUrl,
            ...moveImageFields,
            allCharacters: [
              ...(existing.allCharacters || []),
              ...additionalNamesParsed.added,
            ],
            addedByUserId: existing.addedByUserId,
            addedByTag: existing.addedByTag,
            addedByDisplayName: existing.addedByDisplayName,
            addedAt: existing.addedAt,
            ...(targetType === 'black' ? (() => {
              // Resolve scope priority: explicit user option → existing entry's
              // scope → guild default. This lets type-change + scope-change
              // happen in one command.
              const moveScope = newScope || existingObj.scope || editGuildDefaultScope;
              return { scope: moveScope, guildId: moveScope === 'server' ? editGuildId : '' };
            })() : {}),
          });
          await oldModel.deleteOne({ _id: existing._id });

          // Resolve the freshest evidence URL from the just-created entry so
          // the success embed renders the new image immediately (no broken
          // CDN snapshots, no extra round trip on re-render).
          const moveFreshUrl = await resolveDisplayImageUrl(movedEntry, client);

          await interaction.editReply({
            content: null,
            embeds: [
              buildListEditSuccessEmbed(movedEntry.toObject?.() || movedEntry, {
                changes,
                type: targetType,
                freshDisplayUrl: moveFreshUrl,
                requesterDisplayName: getInteractionDisplayName(interaction),
                isMove: true,
              }),
            ],
          });
        } else {
          // Update in place
          const updateFields = {};
          if (newReason) updateFields.reason = newReason;
          if (newRaid) updateFields.raid = newRaid;
          if (newLogs) updateFields.logsUrl = newLogs;
          if (newImageUrl) {
            // New image provided — use rehost result if successful, else legacy URL
            if (newImageRehost) {
              updateFields.imageUrl = '';
              updateFields.imageMessageId = newImageRehost.messageId;
              updateFields.imageChannelId = newImageRehost.channelId;
            } else {
              updateFields.imageUrl = newImageUrl;
              updateFields.imageMessageId = '';
              updateFields.imageChannelId = '';
            }
          }
          // Scope change in place — only blacklist supports this. Atomic update
          // of {scope, guildId} so the unique index sees the new combination.
          if (isScopeChange) {
            updateFields.scope = targetScope;
            updateFields.guildId = targetScope === 'server' ? editGuildId : '';
          }

          const { model } = getListContext(currentType);
          const updateOps = { $set: updateFields };
          if (additionalNamesParsed.added.length > 0) {
            updateOps.$addToSet = {
              allCharacters: { $each: additionalNamesParsed.added },
            };
          }
          try {
            await model.updateOne({ _id: existing._id }, updateOps);
          } catch (err) {
            // Defense in depth: catch race-condition E11000 from the unique
            // index even though preflight should have caught it. Mongoose
            // wraps the duplicate-key error with code 11000.
            if (err.code === 11000 && isScopeChange) {
              await interaction.editReply({
                content: `⚠️ Cannot change scope: another entry with this name already occupies the target scope (race condition). Try again or remove the conflicting entry.`,
              });
              return;
            }
            throw err;
          }

          // Build a virtual post-edit entry by merging updateFields onto the
          // pre-edit snapshot. Avoids an extra round trip to fetch the updated
          // doc just for the success embed. allCharacters is merged separately
          // because the persisted update used $addToSet, not $set.
          const editedEntry = { ...(existing.toObject?.() || existing), ...updateFields };
          if (additionalNamesParsed.added.length > 0) {
            editedEntry.allCharacters = [
              ...(existing.allCharacters || []),
              ...additionalNamesParsed.added,
            ];
          }
          const editFreshUrl = await resolveDisplayImageUrl(editedEntry, client);

          await interaction.editReply({
            content: null,
            embeds: [
              buildListEditSuccessEmbed(editedEntry, {
                changes,
                type: currentType,
                freshDisplayUrl: editFreshUrl,
                requesterDisplayName: getInteractionDisplayName(interaction),
                isMove: false,
              }),
            ],
          });
        }

        // Broadcast routing decided by the FINAL scope (after any scope change).
        // Skip broadcast for server-scoped entries to avoid spamming other guilds.
        const entryObj = existing.toObject?.() || existing;
        const finalScope = targetType === 'black' ? targetScope : 'global';
        if (!isOwner && finalScope !== 'server') {
          broadcastListChange('edited', { ...entryObj, reason: newReason || existing.reason, raid: newRaid || existing.raid, scope: finalScope }, {
            type: targetType,
            guildId: interaction.guild.id,
            requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
            requestedByTag: interaction.user.tag,
          }).catch(() => {});
        }

      } catch (err) {
        await interaction.editReply({ content: `⚠️ Edit failed: \`${err.message}\`` });
      }
    } else {
      // Not owner, not approver → send approval request
      const existingObj = existing.toObject?.() || existing;

      // Image fields for the approval payload: prefer rehosted refs over URL.
      // The newImageRehost was already attempted at the top of the handler.
      const editImageFields = newImageUrl
        ? (newImageRehost
            ? { imageUrl: newImageRehost.freshUrl || '', imageMessageId: newImageRehost.messageId, imageChannelId: newImageRehost.channelId }
            : { imageUrl: newImageUrl, imageMessageId: '', imageChannelId: '' })
        : { imageUrl: existing.imageUrl || '', imageMessageId: existing.imageMessageId || '', imageChannelId: existing.imageChannelId || '' };

      const payload = {
        requestId: randomUUID(),
        action: 'edit',
        existingEntryId: String(existingObj._id),
        currentType,
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        type: targetType,
        name: existing.name,
        reason: newReason || existing.reason,
        raid: newRaid || existing.raid,
        logsUrl: newLogs || existing.logsUrl || '',
        ...editImageFields,
        // Scope priority: explicit user option → existing entry's scope → guild default.
        // The approval handler at line ~1206 (cross-list move) and ~1230 (in-place)
        // both honor payload.scope when persisting the edit.
        scope: newScope || existingObj.scope || editGuildDefaultScope,
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        createdAt: Date.now(),
      };

      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload, {
        title: 'List Edit — Approval Required',
      });

      if (!sent.success) {
        await interaction.editReply({ content: `⚠️ ${sent.reason}` });
        return;
      }

      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        content: `📨 Edit request sent for approval.\nChanges:\n${changes.map((c) => `• ${c}`).join('\n')}`,
      });
    }
  }

  return { handleListEditCommand };
}
