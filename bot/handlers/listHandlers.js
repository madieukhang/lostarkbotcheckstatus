import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
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
} from '../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../services/listCheckService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../utils/names.js';

// Approver IDs loaded from environment variables
const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;
const MEMBER_APPROVER_IDS = config.memberApproverIds;

function getListContext(type) {
  if (type === 'black') {
    return { model: Blacklist, label: 'blacklist', color: 0xed4245, icon: '⛔' };
  }
  if (type === 'watch') {
    return { model: Watchlist, label: 'watchlist', color: 0xfee75c, icon: '⚠️' };
  }
  return { model: Whitelist, label: 'whitelist', color: 0x57f287, icon: '✅' };
}

/**
 * Build a standardized embed for trusted user block messages.
 */
function buildTrustedBlockEmbed(name, reason, { via } = {}) {
  const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
  const description = via
    ? `**${name}** shares a roster with trusted user **${via}** and cannot be blacklisted.`
    : `**${name}** is a trusted user and cannot be added to the blacklist.`;

  return new EmbedBuilder()
    .setTitle('🛡️ Trusted User — Blocked')
    .setDescription(description)
    .addFields(
      { name: 'Name', value: `[${name}](${rosterLink})`, inline: true },
      { name: 'Trust reason', value: reason || 'N/A', inline: true },
    )
    .setColor(0x57d6a1)
    .setTimestamp(new Date());
}

function buildListAddApprovalEmbed(guild, payload, options = {}) {
  const title = options.title || 'List Add — Approval Required';
  const includeRequestedBy = options.includeRequestedBy ?? true;
  const fields = [
    { name: 'Request ID', value: payload.requestId, inline: false },
    { name: 'Type', value: payload.type, inline: true },
    { name: 'Name', value: payload.name, inline: true },
    { name: 'Raid', value: payload.raid || 'N/A', inline: true },
    { name: 'Reason', value: payload.reason, inline: false },
  ];

  if (includeRequestedBy) {
    fields.push({
      name: 'Requested by',
      value: `${payload.requestedByDisplayName} (<@${payload.requestedByUserId}>)`,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(payload.action === 'edit'
      ? `A list edit request was submitted in **${guild.name}**.`
      : `A new list add request was submitted in **${guild.name}**.`)
    .addFields(fields)
    .setColor(payload.type === 'black' ? 0xed4245 : 0x57f287)
    .setTimestamp(new Date());

  if (payload.imageUrl) {
    embed.setImage(payload.imageUrl);
  }

  return embed;
}

function getApproverRecipientIds() {
  const officers = OFFICER_APPROVER_IDS.filter(Boolean);
  const recipientIds = [];

  for (const id of SENIOR_APPROVER_IDS) {
    if (id && !recipientIds.includes(id)) recipientIds.push(id);
  }

  if (officers.length > 0) {
    const randomOfficerId = officers[Math.floor(Math.random() * officers.length)];
    if (!recipientIds.includes(randomOfficerId)) {
      recipientIds.push(randomOfficerId);
    }
  }

  return recipientIds;
}

function isRequesterAutoApprover(userId) {
  if (!userId) return false;
  if (SENIOR_APPROVER_IDS.includes(userId)) return true;
  if (OFFICER_APPROVER_IDS.includes(userId)) return true;
  return MEMBER_APPROVER_IDS.includes(userId);
}

function buildApprovalResultRow(actionLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_approved_done')
      .setLabel(actionLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

function buildApprovalProcessingRow(action) {
  const isApprove = action === 'listadd_approve';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_processing_approve')
      .setLabel(isApprove ? 'Approving...' : 'Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('listadd_processing_reject')
      .setLabel(!isApprove ? 'Rejecting...' : 'Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true)
  );
}

export function createListHandlers({ client }) {

  async function sendListAddApprovalToApprovers(guild, payload, options = {}) {
    const approverIds = getApproverRecipientIds();
    if (approverIds.length === 0) {
      return { success: false, reason: 'No approver user IDs configured. Set SENIOR_APPROVER_IDS or OFFICER_APPROVER_IDS in env.' };
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`listadd_approve:${payload.requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`listadd_reject:${payload.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
    );

    const embed = buildListAddApprovalEmbed(guild, payload, options);
    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;

          const sentMessage = await user.send({ embeds: [embed], components: [row] });
          deliveredApproverIds.push(user.id);
          deliveredDmMessages.push({
            approverId: user.id,
            channelId: sentMessage.channelId,
            messageId: sentMessage.id,
          });
        } catch (err) {
          console.warn(`[list] Failed to DM approver ${approverId}:`, err.message);
        }
      })
    );

    if (deliveredApproverIds.length === 0) {
      return { success: false, reason: 'Unable to DM configured approvers. Check user IDs/privacy settings.' };
    }

    return { success: true, deliveredApproverIds, deliveredDmMessages };
  }

  async function syncApproverDmMessages(payload, messageOptions, options = {}) {
    const refs = payload.approverDmMessages || [];
    if (refs.length === 0) return;

    const excludeMessageId = options.excludeMessageId || '';

    await Promise.all(
      refs.map(async (ref) => {
        if (!ref?.channelId || !ref?.messageId) return;
        if (excludeMessageId && ref.messageId === excludeMessageId) return;

        try {
          const dmChannel = await client.channels.fetch(ref.channelId);
          if (!dmChannel || !dmChannel.isTextBased()) return;

          const dmMessage = await dmChannel.messages.fetch(ref.messageId);
          await dmMessage.edit(messageOptions);
        } catch (err) {
          console.warn(`[list] Failed to sync approver DM ${ref.messageId}:`, err.message);
        }
      })
    );
  }

  async function executeListAddToDatabase(payload) {
    const { model, label, color, icon } = getListContext(payload.type);
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const name = normalizeCharacterName(payload.name);

    // Step 0: Trusted user guard (exact name check — fast, before roster fetch)
    if (payload.type === 'black') {
      const trustedExact = await TrustedUser.findOne({ name })
        .collation({ locale: 'en', strength: 2 }).lean();
      if (trustedExact) {
        return {
          ok: false,
          content: `🛡️ **${name}** is a trusted user and cannot be blacklisted.`,
          embeds: [buildTrustedBlockEmbed(name, trustedExact.reason)],
        };
      }
    }

    // Step 1: Check if character exists
    const { hasValidRoster, allCharacters, targetItemLevel } = await buildRosterCharacters(name);
    if (!hasValidRoster) {
      const suggestions = await fetchNameSuggestions(name);
      if (suggestions.length > 0) {
        const suggestionLines = suggestions
          .slice(0, 10)
          .map(
            (s, idx) =>
              `**${idx + 1}.** [${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel || 0).toFixed(2)}\` — ${getClassName(s.cls)}`
          )
          .join('\n');

        const suggEmbed = new EmbedBuilder()
          .setTitle('No Roster Found')
          .setDescription(suggestionLines)
          .setColor(0xfee75c)
          .setTimestamp();

        return {
          ok: false,
          content: `❌ No roster found for **${name}**. Use one of the suggested names.`,
          embeds: [suggEmbed],
        };
      }

      return {
        ok: false,
        content: `❌ No roster found for **${name}**. No similar names found.`,
        embeds: [],
      };
    }

    // Step 2: Check ilvl >= 1700 (using exact ilvl from roster, not regex on HTML)
    if (targetItemLevel !== null && targetItemLevel < 1700) {
      return {
        ok: false,
        content: `❌ **${name}** has item level \`${targetItemLevel.toFixed(2)}\` (below 1700). Cannot add to ${label}.`,
        embeds: [],
      };
    }

    // Step 2b: Trusted user guard (alt check — after roster gives us allCharacters)
    if (payload.type === 'black' && allCharacters.length > 0) {
      const trustedAlt = await TrustedUser.findOne({ name: { $in: allCharacters } })
        .collation({ locale: 'en', strength: 2 }).lean();
      if (trustedAlt) {
        return {
          ok: false,
          content: `🛡️ **${name}** shares a roster with trusted user **${trustedAlt.name}**.`,
          embeds: [buildTrustedBlockEmbed(name, trustedAlt.reason, { via: trustedAlt.name })],
        };
      }
    }

    // Step 3: Check if already in list (scope-aware for blacklist)
    await connectDB();

    const entryScope = payload.scope || 'global';
    const entryGuildId = entryScope === 'server' ? (payload.guildId || '') : '';

    let dupeQuery;
    if (payload.type === 'black') {
      // For blacklist: check global + this server's entries (avoid redundant adds)
      dupeQuery = {
        $and: [
          { $or: [{ name }, { allCharacters: name }] },
          { $or: [
            { scope: 'global' },
            { scope: { $exists: false } }, // backward compat: old entries without scope
            ...(entryGuildId ? [{ scope: 'server', guildId: entryGuildId }] : []),
          ] },
        ],
      };
    } else {
      dupeQuery = { $or: [{ name }, { allCharacters: name }] };
    }

    const existed = await model.findOne(dupeQuery)
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (existed) {
      const isRosterMatch = existed.name.toLowerCase() !== name.toLowerCase();
      const via = isRosterMatch ? ` (roster match: **${existed.name}** is already in ${label})` : '';
      const scopeNote = existed.scope === 'server' ? ' [Server]' : '';
      return {
        ok: false,
        isDuplicate: true,
        existingEntry: existed,
        content: `⚠️ **${name}** already exists in ${label}.${via}${scopeNote}`,
        embeds: [],
      };
    }

    // Step 4: Create entry
    const createData = {
      name,
      reason: payload.reason,
      raid: payload.raid,
      logsUrl: payload.logsUrl || '',
      imageUrl: payload.imageUrl,
      allCharacters,
      addedByUserId: payload.requestedByUserId,
      addedByTag: payload.requestedByTag,
      addedByName: payload.requestedByName,
      addedByDisplayName: payload.requestedByDisplayName,
    };

    // Add scope fields for blacklist entries
    if (payload.type === 'black') {
      createData.scope = entryScope;
      createData.guildId = entryGuildId;
    }

    const entry = await model.create(createData);

    // Build result embed with character links
    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;
    const autoLogsLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/logs`;

    const linkParts = [`[Roster](${rosterLink})`, `[Logs](${autoLogsLink})`];
    if (payload.logsUrl) linkParts.push(`[Evidence Logs](${payload.logsUrl})`);

    const allCharsDisplay = allCharacters.length <= 6
      ? allCharacters.join(', ')
      : allCharacters.slice(0, 6).join(', ') + ` +${allCharacters.length - 6} more`;

    const scopeTag = (payload.type === 'black' && entryScope === 'server') ? ' [Server]' : '';
    const embed = new EmbedBuilder()
      .setTitle(`${labelCap}${scopeTag} — Entry Added`)
      .addFields(
        { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: payload.reason || 'N/A', inline: true },
        { name: 'Raid', value: payload.raid || 'N/A', inline: true },
        { name: `All Characters (${allCharacters.length})`, value: allCharsDisplay, inline: false },
        { name: 'Links', value: linkParts.join(' · '), inline: false }
      )
      .setColor(color)
      .setTimestamp(new Date());

    if (payload.imageUrl) {
      embed.setImage(payload.imageUrl);
    }

    // Broadcast only global entries — server-scoped entries stay private
    if (entryScope !== 'server') {
      broadcastListChange('added', entry, payload).catch((err) =>
        console.warn('[list] Broadcast failed:', err.message)
      );
    }

    return {
      ok: true,
      content: `${icon} Added **${entry.name}** to ${label}.${scopeTag ? ' *(server only)*' : ''}`,
      embeds: [embed],
    };
  }

  async function broadcastListChange(action, entry, payload) {
    const { label, color, icon } = getListContext(payload.type);
    const addedBy = payload.requestedByDisplayName || payload.requestedByTag || 'Unknown';
    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;

    // Capitalize label for title (blacklist → Blacklist)
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const actionCap = action.charAt(0).toUpperCase() + action.slice(1);

    const embed = new EmbedBuilder()
      .setTitle(`📢 ${icon} ${labelCap} — ${actionCap}`)
      .addFields(
        { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: entry.reason || 'N/A', inline: true },
      )
      .setColor(color)
      .setTimestamp(new Date());

    if (entry.raid) embed.addFields({ name: 'Raid', value: entry.raid, inline: true });
    if (entry.imageUrl) embed.setImage(entry.imageUrl);

    // Collect notification channel IDs from OTHER guilds only
    // Skip the guild where the action originated — user already sees the reply there
    const originGuildId = payload.guildId || '';
    const channelIds = new Set();

    let hasAnyGuildConfig = false;
    try {
      // Query ALL GuildConfigs (not just ones with notify channels)
      // so opt-out guilds without notifychannel are still detected
      const guildConfigs = await GuildConfig.find({}).lean();
      hasAnyGuildConfig = guildConfigs.length > 0;
      for (const gc of guildConfigs) {
        if (gc.guildId === originGuildId) continue; // skip same server
        if (gc.globalNotifyEnabled === false) continue; // skip opted-out servers
        if (!gc.listNotifyChannelId) continue; // skip configs without notify channel
        channelIds.add(gc.listNotifyChannelId);
      }
    } catch (err) {
      console.warn('[list] Failed to query GuildConfig for broadcast:', err.message);
    }

    // Only use env var channels if no guild has used /lasetup at all
    // (any GuildConfig existing = system is DB-managed, no env fallback)
    if (channelIds.size === 0 && !hasAnyGuildConfig) {
      for (const id of config.listNotifyChannelIds) {
        channelIds.add(id);
      }
    }

    if (channelIds.size === 0) return;

    await Promise.all(
      [...channelIds].map(async (channelId) => {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel?.isTextBased()) {
            await channel.send({ embeds: [embed] });
          }
        } catch (err) {
          console.warn(`[list] Failed to broadcast to channel ${channelId}:`, err.message);
        }
      })
    );
  }

  async function notifyRequesterAboutDecision(payload, result, rejected = false) {
    try {
      const guild = await client.guilds.fetch(payload.guildId);
      const channel = await guild.channels.fetch(payload.channelId);

      if (!channel || !channel.isTextBased()) return;

      const actionLabel = payload.action === 'edit' ? 'edit' : 'add';
      const decisionContent = rejected
        ? `<@${payload.requestedByUserId}> ❌ Your list ${actionLabel} request for **${payload.name}** was rejected by Officer.`
        : `<@${payload.requestedByUserId}> ${result.content}`;

      const decisionPayload = {
        content: decisionContent,
        embeds: rejected ? [] : (result.embeds ?? []),
      };

      if (payload.requestMessageId && 'messages' in channel) {
        try {
          const requestMessage = await channel.messages.fetch(payload.requestMessageId);
          await requestMessage.reply(decisionPayload);
          return;
        } catch (err) {
          console.warn('[list] Failed to reply on original request message, falling back to channel send:', err.message);
        }
      }

      await channel.send(decisionPayload);
    } catch (err) {
      console.warn('[list] Failed to notify requester in origin channel:', err.message);
    }
  }

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
          if (payload.type === 'black') {
            const trustedNow = await TrustedUser.findOne({
              $or: [{ name: existingEntry.name }, ...(existingEntry.allCharacters?.length > 0 ? [{ name: { $in: existingEntry.allCharacters } }] : [])],
            }).collation({ locale: 'en', strength: 2 }).lean();
            if (trustedNow) {
              await PendingApproval.deleteOne({ requestId });
              await interaction.editReply({
                content: `🛡️ **${existingEntry.name}** is now a trusted user — blocked.`,
                embeds: [buildTrustedBlockEmbed(existingEntry.name, trustedNow.reason)],
                components: [buildApprovalResultRow('Blocked')],
              });
              return;
            }
          }

          // Create first, then delete old (safe order — if create fails, old preserved)
          await newModel.create({
            name: existingEntry.name,
            reason: payload.reason || existingEntry.reason,
            raid: payload.raid || existingEntry.raid,
            logsUrl: payload.logsUrl || existingEntry.logsUrl,
            imageUrl: payload.imageUrl || existingEntry.imageUrl,
            allCharacters: existingEntry.allCharacters || [],
            addedByUserId: existingEntry.addedByUserId,
            addedByTag: existingEntry.addedByTag,
            addedByDisplayName: existingEntry.addedByDisplayName,
            addedAt: existingEntry.addedAt,
            ...(payload.type === 'black' ? { scope: payload.scope || existingEntry.scope || 'global', guildId: existingEntry.guildId || '' } : {}),
          });
          await oldModel.deleteOne({ _id: existingEntry._id });
        } else {
          const updateFields = {};
          if (payload.reason && payload.reason !== existingEntry.reason) updateFields.reason = payload.reason;
          if (payload.raid && payload.raid !== existingEntry.raid) updateFields.raid = payload.raid;
          if (payload.logsUrl && payload.logsUrl !== existingEntry.logsUrl) updateFields.logsUrl = payload.logsUrl;
          if (payload.imageUrl && payload.imageUrl !== existingEntry.imageUrl) updateFields.imageUrl = payload.imageUrl;
          if (Object.keys(updateFields).length > 0) {
            await oldModel.updateOne({ _id: existingEntry._id }, { $set: updateFields });
          }
        }

        // Broadcast only if entry is global-scoped
        const entryScope = existingEntry.scope || payload.scope || 'global';
        if (entryScope !== 'server') {
          broadcastListChange('edited', { ...existingEntry.toObject?.() || existingEntry, reason: payload.reason || existingEntry.reason, raid: payload.raid || existingEntry.raid }, {
            type: payload.type,
            guildId: payload.guildId,
            requestedByDisplayName: payload.requestedByDisplayName,
            requestedByTag: payload.requestedByTag,
          }).catch(() => {});
        }

        await PendingApproval.deleteOne({ requestId });
        const editResult = { ok: true, content: `✅ Edit approved: **${existingEntry.name}**${isTypeChange ? ` moved to ${newLabel}` : ' updated'}.` };

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

  async function handleListCheckCommand(interaction) {
    const image = interaction.options.getAttachment('image', true);
    let names = [];

    await interaction.deferReply();

    try {
      names = await extractNamesFromImage(image);
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ Failed to extract names from image: \`${err.message}\``,
      });
      return;
    }

    if (names.length === 0) {
      await interaction.editReply({
        content: '⚠️ No valid names found in the uploaded image. Please use a clearer screenshot.',
      });
      return;
    }

    const limitedNames = names.slice(0, 8);

    try {
      const results = await checkNamesAgainstLists(limitedNames, { guildId: interaction.guild?.id });
      const lines = formatCheckResults(results);

      const sections = [
        `Checked: **${limitedNames.length}** name(s)`,
        limitedNames.length < names.length ? `Ignored: **${names.length - limitedNames.length}** extra name(s) (limit: 8)` : null,
        '',
        ...lines,
      ].filter((line) => line !== null);

      await interaction.editReply({
        content: sections.join('\n'),
      });

      // Fire-and-forget: enrich allCharacters in background for flagged entries
      const flaggedItems = results.filter((item) => item.blackEntry || item.whiteEntry || item.watchEntry);
      if (flaggedItems.length > 0) {
        (async () => {
          for (const item of flaggedItems) {
            const listEntry = item.blackEntry || item.whiteEntry || item.watchEntry;
            try {
              const altResult = await detectAltsViaStronghold(item.name);
              if (altResult && altResult.alts.length > 0) {
                const newAltNames = altResult.alts.map((a) => a.name);
                const existingAlts = listEntry.allCharacters || [];
                const merged = [...new Set([...existingAlts, item.name, ...newAltNames])];

                if (merged.length > existingAlts.length) {
                  const model = item.blackEntry ? Blacklist : item.whiteEntry ? Whitelist : Watchlist;
                  await model.updateOne(
                    { _id: listEntry._id },
                    { $set: { allCharacters: merged } }
                  );
                  console.log(`[listcheck] Enriched ${listEntry.name} allCharacters: ${existingAlts.length} → ${merged.length}`);
                }
              }
            } catch (err) {
              console.warn(`[listcheck] Alt enrichment failed for ${item.name}:`, err.message);
            }
          }
        })().catch((err) => console.error('[listcheck] Background enrichment error:', err.message));
      }
    } catch (err) {
      console.error('[listcheck] ❌ Check failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to run list check: \`${err.message}\``,
      });
    }
  }

  async function handleListAddCommand(interaction) {
    const type = interaction.options.getString('type', true);
    const rawName = interaction.options.getString('name', true).trim();
    const reason = interaction.options.getString('reason', true).trim();
    const raid = interaction.options.getString('raid') ?? '';
    const logs = interaction.options.getString('logs') ?? '';
    const image = interaction.options.getAttachment('image');
    const scope = interaction.options.getString('scope') || 'global';
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    if (!interaction.guild) {
      await interaction.editReply({
        content: '❌ This command can only be used in a server.',
      });
      return;
    }

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
      const payload = {
        requestId,
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        logsUrl: logs,
        imageUrl: image?.url ?? '',
        scope: type === 'black' ? scope : 'global', // scope only applies to blacklist
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: getInteractionDisplayName(interaction),
        createdAt: Date.now(),
      };

      if (isRequesterAutoApprover(payload.requestedByUserId)) {
        const result = await executeListAddToDatabase(payload);
        await interaction.editReply({
          content: `${result.content}`,
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

  async function handleListRemoveCommand(interaction) {
    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    try {
      await connectDB();

      const removeGuildId = interaction.guild?.id || '';
      const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
        Blacklist.findOne({
          $and: [
            { $or: [{ name }, { allCharacters: name }] },
            { $or: [
              { scope: 'global' },
              { scope: { $exists: false } },
              ...(removeGuildId ? [{ scope: 'server', guildId: removeGuildId }] : []),
            ] },
          ],
        })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Whitelist.findOne({
          $or: [{ name }, { allCharacters: name }],
        })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Watchlist.findOne({
          $or: [{ name }, { allCharacters: name }],
        })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
      ]);

      // Collect all found entries
      const found = [];
      if (blackEntry) found.push({ entry: blackEntry, type: 'black' });
      if (whiteEntry) found.push({ entry: whiteEntry, type: 'white' });
      if (watchEntry) found.push({ entry: watchEntry, type: 'watch' });

      if (found.length === 0) {
        await interaction.editReply({
          content: `⚠️ No list entry found for **${name}**.`,
        });
        return;
      }

      const removeOne = async (entry, type) => {
        const { model, label, icon } = getListContext(type);

        if (!entry.addedByUserId) {
          return `⚠️ **${entry.name}** in ${label} is a legacy entry without owner metadata, so it cannot be removed with this command.`;
        }

        if (entry.addedByUserId !== interaction.user.id) {
          return `⛔ You cannot remove **${entry.name}** from ${label}. Only **${entry.addedByTag || entry.addedByUserId}** (who added it) can remove it.`;
        }

        await model.deleteOne({ _id: entry._id });

        // Only broadcast global removals (server-scoped stay private)
        if (entry.scope !== 'server') {
          broadcastListChange('removed', entry, {
            type,
            guildId: interaction.guild?.id || '',
            requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
            requestedByTag: interaction.user.tag,
          }).catch((err) => console.warn('[list] Broadcast failed:', err.message));
        }

        const scopeNote = entry.scope === 'server' ? ' *(server only)*' : '';
        return `${icon} Removed **${entry.name}** from ${label}.${scopeNote}`;
      };

      // Single entry — remove directly
      if (found.length === 1) {
        const message = await removeOne(found[0].entry, found[0].type);
        await interaction.editReply({ content: message });
        return;
      }

      // Multiple entries — show selection buttons
      const buttonStyles = { black: ButtonStyle.Danger, white: ButtonStyle.Success, watch: ButtonStyle.Secondary };
      const row = new ActionRowBuilder().addComponents(
        ...found.map((f, i) => {
          const { label } = getListContext(f.type);
          return new ButtonBuilder()
            .setCustomId(`remove_${f.type}`)
            .setLabel(`${i + 1}. Remove from ${label}`)
            .setStyle(buttonStyles[f.type] || ButtonStyle.Secondary);
        }),
        new ButtonBuilder()
          .setCustomId('remove_all')
          .setLabel(`${found.length + 1}. Remove all`)
          .setStyle(ButtonStyle.Secondary)
      );

      const listNames = found.map((f) => getListContext(f.type).label).join(' and ');
      await interaction.editReply({
        content: `🔎 Found **${name}** in ${listNames}.\nChoose a removal option:`,
        components: [row],
      });

      const reply = await interaction.fetchReply();
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30000,
      });

      let messages;
      if (button.customId === 'remove_all') {
        messages = await Promise.all(found.map((f) => removeOne(f.entry, f.type)));
      } else {
        const target = found.find((f) => button.customId === `remove_${f.type}`);
        messages = target ? [await removeOne(target.entry, target.type)] : ['⚠️ Unknown selection.'];
      }

      await button.update({
        content: messages.join('\n'),
        components: [],
      });
      return;
    } catch (err) {
      console.error('[list] ❌ Remove failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to remove entry: \`${err.message}\``,
      });
    }
  }

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

    await interaction.deferReply();
    await connectDB();

    // Find existing entry across all lists (scope-aware for blacklist)
    const collation = { locale: 'en', strength: 2 };
    const query = { $or: [{ name }, { allCharacters: name }] };
    const editGuildId = interaction.guild.id;

    const blackQuery = {
      $and: [
        query,
        { $or: [
          { scope: 'global' },
          { scope: { $exists: false } },
          { scope: 'server', guildId: editGuildId },
        ] },
      ],
    };

    const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
      Blacklist.findOne(blackQuery).collation(collation),
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

    // Check if anything is actually changing
    if (!newReason && !newType && !newRaid && !newLogs && !newImageUrl) {
      await interaction.editReply({ content: `⚠️ No changes provided. Use options to specify what to edit.` });
      return;
    }

    const targetType = newType || currentType;
    const isTypeChange = targetType !== currentType;

    // Build changes summary
    const changes = [];
    if (newReason) changes.push(`Reason: "${existing.reason}" → "${newReason}"`);
    if (isTypeChange) changes.push(`List: ${currentLabel} → ${getListContext(targetType).label}`);
    if (newRaid) changes.push(`Raid: "${existing.raid || 'N/A'}" → "${newRaid}"`);
    if (newLogs) changes.push(`Logs: updated`);
    if (newImageUrl) changes.push(`Evidence: updated`);

    // Trusted user guard: block moving to blacklist if target is trusted
    if (targetType === 'black' && currentType !== 'black') {
      const trustedCheck = await TrustedUser.findOne({
        $or: [
          { name: existing.name },
          ...(existing.allCharacters?.length > 0 ? [{ name: { $in: existing.allCharacters } }] : []),
        ],
      }).collation({ locale: 'en', strength: 2 }).lean();
      if (trustedCheck) {
        const isSelf = trustedCheck.name.toLowerCase() === existing.name.toLowerCase();
        await interaction.editReply({
          content: `🛡️ **${existing.name}** cannot be moved to the blacklist.`,
          embeds: [buildTrustedBlockEmbed(existing.name, trustedCheck.reason, isSelf ? {} : { via: trustedCheck.name })],
        });
        return;
      }
    }

    // Check ownership: same person → apply now, different → approval
    const isOwner = existing.addedByUserId === interaction.user.id;
    const isApprover = isRequesterAutoApprover(interaction.user.id);

    if (isOwner || isApprover) {
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
          await newModel.create({
            name: existing.name,
            reason: newReason || existing.reason,
            raid: newRaid || existing.raid,
            logsUrl: newLogs || existing.logsUrl,
            imageUrl: newImageUrl || existing.imageUrl,
            allCharacters: existing.allCharacters || [],
            addedByUserId: existing.addedByUserId,
            addedByTag: existing.addedByTag,
            addedByDisplayName: existing.addedByDisplayName,
            addedAt: existing.addedAt,
            ...(targetType === 'black' ? { scope: existingObj.scope || 'global', guildId: existingObj.guildId || '' } : {}),
          });
          await oldModel.deleteOne({ _id: existing._id });

          await interaction.editReply({
            content: `✅ **${existing.name}** edited and moved to ${newLabel}.\n${changes.map((c) => `• ${c}`).join('\n')}`,
          });
        } else {
          // Update in place
          const updateFields = {};
          if (newReason) updateFields.reason = newReason;
          if (newRaid) updateFields.raid = newRaid;
          if (newLogs) updateFields.logsUrl = newLogs;
          if (newImageUrl) updateFields.imageUrl = newImageUrl;

          const { model } = getListContext(currentType);
          await model.updateOne({ _id: existing._id }, { $set: updateFields });

          await interaction.editReply({
            content: `✅ **${existing.name}** edited in ${currentLabel}.\n${changes.map((c) => `• ${c}`).join('\n')}`,
          });
        }

        // Only broadcast if editor is NOT the original owner AND entry is not server-scoped
        const entryObj = existing.toObject?.() || existing;
        if (!isOwner && entryObj.scope !== 'server') {
          broadcastListChange('edited', { ...entryObj, reason: newReason || existing.reason, raid: newRaid || existing.raid }, {
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
        imageUrl: newImageUrl || existing.imageUrl || '',
        scope: existingObj.scope || 'global', // preserve existing scope
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

  async function handleListViewCommand(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const type = interaction.options.getString('type', true);
    const scopeFilter = interaction.options.getString('scope') || '';
    const ITEMS_PER_PAGE = 10;

    await interaction.deferReply();

    try {
      await connectDB();

      // Handle trusted list separately (different model/schema)
      if (type === 'trusted') {
        const trustedEntries = await TrustedUser.find({}).sort({ addedAt: -1 }).lean();
        if (trustedEntries.length === 0) {
          await interaction.editReply({ content: '🛡️ Trusted list is empty.' });
          return;
        }

        const lines = trustedEntries.map((e, i) => {
          const parts = [`🛡️ **${e.name}**`];
          if (e.reason) parts.push(e.reason);
          const date = e.addedAt ? `<t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>` : '';
          if (date) parts.push(date);
          return `${i + 1}. ${parts.join(' — ')}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Trusted Users (${trustedEntries.length})`)
          .setDescription(lines.join('\n'))
          .setColor(0x57d6a1)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // When scope filter is set, only include blacklist (scope only applies to blacklist)
      let types;
      if (scopeFilter && type === 'all') {
        types = ['black'];
      } else {
        types = type === 'all' ? ['black', 'white', 'watch'] : [type];
      }
      const allEntries = [];
      const viewGuildId = interaction.guild.id;
      const isOwnerGuild = viewGuildId === config.ownerGuildId;

      for (const t of types) {
        const { model, label, color, icon } = getListContext(t);

        // Blacklist: scope-aware query depending on who's viewing
        let query = {};
        if (t === 'black' && viewGuildId) {
          if (isOwnerGuild && (!scopeFilter || scopeFilter === 'all')) {
            // Owner server, no filter or "all" → see everything
            query = {};
          } else if (scopeFilter === 'global') {
            query = { $or: [{ scope: 'global' }, { scope: { $exists: false } }] };
          } else if (scopeFilter === 'server') {
            if (isOwnerGuild) {
              // Owner sees all server-scoped entries
              query = { scope: 'server' };
            } else {
              // Other servers see only their own
              query = { scope: 'server', guildId: viewGuildId };
            }
          } else {
            // Default for non-owner: global + own server entries
            query = { $or: [
              { scope: 'global' },
              { scope: { $exists: false } },
              { scope: 'server', guildId: viewGuildId },
            ] };
          }
        }

        const entries = await model.find(query).sort({ addedAt: -1 }).lean();
        for (const e of entries) {
          allEntries.push({ ...e, _listType: t, _label: label, _color: color, _icon: icon });
        }
      }

      if (allEntries.length === 0) {
        await interaction.editReply({ content: type === 'all' ? 'All lists are empty.' : `${getListContext(type).icon} ${getListContext(type).label} is empty.` });
        return;
      }

      // Sort all entries by addedAt (newest first)
      allEntries.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

      // Resolve guild names for server-scoped entries (owner view shows which server)
      const guildNameCache = new Map();
      if (isOwnerGuild) {
        const serverGuildIds = [...new Set(
          allEntries.filter((e) => e.scope === 'server' && e.guildId).map((e) => e.guildId)
        )];
        await Promise.all(serverGuildIds.map(async (gid) => {
          try {
            const guild = await client.guilds.fetch(gid);
            guildNameCache.set(gid, guild.name);
          } catch {
            guildNameCache.set(gid, gid); // fallback to ID if can't resolve
          }
        }));
      }

      const totalPages = Math.ceil(allEntries.length / ITEMS_PER_PAGE);
      let currentPage = 0;

      function buildPage(page) {
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);

        const lines = pageEntries.map((e, i) => {
          let scopeLabel = '';
          if (e.scope === 'server') {
            if (isOwnerGuild && e.guildId) {
              const gName = guildNameCache.get(e.guildId) || e.guildId;
              scopeLabel = ` \`[S:${gName}]\``;
            } else {
              scopeLabel = ' `[S]`';
            }
          }
          const parts = [`${e._icon} **${e.name}**${scopeLabel}`];
          if (e.reason) parts.push(e.reason);
          if (e.raid) parts.push(`[${e.raid}]`);
          const date = e.addedAt ? `<t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>` : '';
          if (date) parts.push(date);
          if (e.imageUrl) parts.push(`[📎](${e.imageUrl})`);
          return `${start + i + 1}. ${parts.join(' — ')}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(type === 'all' ? `All Lists (${allEntries.length})` : `${getListContext(type).icon} ${getListContext(type).label} (${allEntries.length})`)
          .setDescription(lines.join('\n'))
          .setColor(type === 'all' ? 0x5865f2 : getListContext(type).color)
          .setFooter({ text: `Page ${page + 1}/${totalPages}` })
          .setTimestamp();

        return embed;
      }

      function buildComponents(page) {
        const rows = [];

        // Navigation buttons
        const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('listview_prev')
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('listview_next')
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),
        );
        rows.push(navRow);

        // Evidence dropdown for entries with images on current page
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);
        const withImages = pageEntries.filter((e) => e.imageUrl);

        if (withImages.length > 0) {
          const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('listview_evidence')
              .setPlaceholder('📎 View evidence for...')
              .addOptions(
                withImages.slice(0, 25).map((e, i) => ({
                  label: e.name,
                  description: (e.reason || 'No reason').slice(0, 100),
                  value: String(start + pageEntries.indexOf(e)),
                  emoji: e._icon,
                }))
              )
          );
          rows.push(selectRow);
        }

        return rows;
      }

      const components = buildComponents(0);

      await interaction.editReply({
        embeds: [buildPage(0)],
        components,
      });


      const reply = await interaction.fetchReply();
      const collector = reply.createMessageComponentCollector({
        time: 300000,
      });

      collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i.reply({ content: '⛔ Only the command user can navigate.', ephemeral: true });
          return;
        }

        if (i.customId === 'listview_prev') {
          currentPage = Math.max(0, currentPage - 1);
          await i.update({ embeds: [buildPage(currentPage)], components: buildComponents(currentPage) });
        } else if (i.customId === 'listview_next') {
          currentPage = Math.min(totalPages - 1, currentPage + 1);
          await i.update({ embeds: [buildPage(currentPage)], components: buildComponents(currentPage) });
        } else if (i.customId === 'listview_evidence') {
          const idx = parseInt(i.values[0]);
          const entry = allEntries[idx];

          if (!entry?.imageUrl) {
            await i.reply({ content: 'No evidence image for this entry.', ephemeral: true });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle(`${entry._icon} ${entry.name}`)
            .addFields(
              { name: 'Reason', value: entry.reason || 'N/A', inline: true },
              { name: 'Raid', value: entry.raid || 'N/A', inline: true },
              { name: 'List', value: entry._label, inline: true },
            )
            .setImage(entry.imageUrl)
            .setColor(entry._color)
            .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

          if (entry.logsUrl) {
            embed.addFields({ name: 'Logs', value: `[View Logs](${entry.logsUrl})`, inline: false });
          }

          // Show "Added by" only to officers/seniors (ephemeral = only they see it)
          const isOfficer = OFFICER_APPROVER_IDS.includes(i.user.id)
            || SENIOR_APPROVER_IDS.includes(i.user.id);
          if (isOfficer && entry.addedByDisplayName) {
            embed.addFields({ name: 'Added by', value: entry.addedByDisplayName, inline: true });
          }

          await i.reply({ embeds: [embed], ephemeral: true });
        }
      });

      collector.on('end', async () => {
        const disabledNav = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('listview_prev_disabled').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('listview_next_disabled').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        await interaction.editReply({
          content: '⏱️ Session expired. Use `/list view` again to browse.',
          components: [disabledNav],
        }).catch(() => {});
      });
    } catch (err) {
      console.error(`[list] View failed:`, err.message);
      await interaction.editReply({ content: `⚠️ Failed to load list: \`${err.message}\`` });
    }
  }

  async function handleQuickAddSelect(interaction) {
    const name = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId(`quickadd_modal:${name}`)
      .setTitle(`Quick Add — ${name}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_type')
            .setLabel('Type (black / watch)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('black')
            .setValue('black')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_reason')
            .setLabel('Reason')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Why add this player?')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_raid')
            .setLabel('Raid (optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. Kazeros Hard')
            .setRequired(false)
        ),
      );

    await interaction.showModal(modal);
  }

  async function handleQuickAddModal(interaction) {
    const name = interaction.customId.split(':')[1];
    let type = interaction.fields.getTextInputValue('quickadd_type').trim().toLowerCase();
    const reason = interaction.fields.getTextInputValue('quickadd_reason').trim();
    const raid = interaction.fields.getTextInputValue('quickadd_raid')?.trim() || '';

    // Validate type
    if (!['black', 'white', 'watch'].includes(type)) type = 'black';

    await interaction.deferReply({ ephemeral: true });

    if (!reason) {
      await interaction.editReply({ content: '❌ Reason cannot be empty.' });
      return;
    }

    try {
      const payload = {
        requestId: randomUUID(),
        guildId: interaction.guild?.id || '',
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        logsUrl: '',
        imageUrl: '',
        scope: 'global', // Quick Add defaults to global scope
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        createdAt: Date.now(),
      };

      if (isRequesterAutoApprover(payload.requestedByUserId)) {
        const result = await executeListAddToDatabase(payload);
        await interaction.editReply({
          content: result.content,
          embeds: result.embeds ?? [],
        });
        return;
      }

      // Non-approver → send approval request
      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({ content: `⚠️ ${sent.reason}` });
        return;
      }

      await connectDB();
      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        content: `📨 Approval request sent for **${name}** → ${type}list.`,
      });
    } catch (err) {
      console.error('[quickadd] Failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed: \`${err.message}\``,
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
      const rosterResult = await buildRosterCharacters(newName).catch(() => null);

      dupeEntry.name = newName;
      // Only update roster if fetch succeeded — preserve old snapshot on failure
      if (rosterResult?.hasValidRoster && rosterResult.allCharacters?.length > 0) {
        dupeEntry.allCharacters = rosterResult.allCharacters;
      }
      dupeEntry.reason = payload.reason || dupeEntry.reason;
      dupeEntry.raid = payload.raid || dupeEntry.raid;
      dupeEntry.logsUrl = payload.logsUrl || dupeEntry.logsUrl;
      dupeEntry.imageUrl = payload.imageUrl || dupeEntry.imageUrl;
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

      // Broadcast overwrite (only global-scoped)
      if (dupeEntry.scope !== 'server') {
        broadcastListChange('edited', dupeEntry, {
          type: payload.type,
          guildId: payload.guildId,
          requestedByDisplayName: payload.requestedByDisplayName,
          requestedByTag: payload.requestedByTag,
        }).catch(() => {});
      }

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

  // ─── Trusted user management ──────────────────────────────────────────────

  async function handleListTrustCommand(interaction) {
    const userId = interaction.user.id;
    const isOfficerOrSenior = OFFICER_APPROVER_IDS.includes(userId) || SENIOR_APPROVER_IDS.includes(userId);

    if (!isOfficerOrSenior) {
      await interaction.reply({ content: '❌ Only officers and seniors can manage the trusted list.', ephemeral: true });
      return;
    }

    const action = interaction.options.getString('action', true);
    const rawName = interaction.options.getString('name', true);
    const name = normalizeCharacterName(rawName);
    const reason = interaction.options.getString('reason') || '';

    await interaction.deferReply();
    await connectDB();

    if (action === 'remove') {
      const deleted = await TrustedUser.findOneAndDelete({ name }).collation({ locale: 'en', strength: 2 });
      if (!deleted) {
        await interaction.editReply({ content: `⚠️ **${name}** is not in the trusted list.` });
        return;
      }

      const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(deleted.name)}/roster`;
      const embed = new EmbedBuilder()
        .setTitle('🛡️ Trusted — Entry Removed')
        .addFields(
          { name: 'Name', value: `[${deleted.name}](${rosterLink})`, inline: true },
          { name: 'Was trusted for', value: deleted.reason || 'N/A', inline: true },
          { name: 'Removed by', value: interaction.user.tag, inline: true },
        )
        .setColor(0xed4245)
        .setFooter({ text: 'This character can now be blacklisted' })
        .setTimestamp(new Date());

      await interaction.editReply({
        content: `🗑️ Removed **${deleted.name}** from the trusted list.`,
        embeds: [embed],
      });

      console.log(`[list] Trusted user removed: ${deleted.name} by ${interaction.user.tag}`);
      return;
    }

    // action === 'add'
    const existing = await TrustedUser.findOne({ name }).collation({ locale: 'en', strength: 2 });
    if (existing) {
      await interaction.editReply({ content: `⚠️ **${existing.name}** is already in the trusted list.` });
      return;
    }

    // Block trust if character is currently blacklisted (scope-aware)
    const trustGuildId = interaction.guild?.id || '';
    const isOwnerGuild = trustGuildId === config.ownerGuildId;
    const nameMatch = { $or: [{ name }, { allCharacters: name }] };
    const scopeFilter = isOwnerGuild
      ? {}
      : { $or: [
          { scope: 'global' },
          { scope: { $exists: false } },
          ...(trustGuildId ? [{ scope: 'server', guildId: trustGuildId }] : []),
        ] };
    const blackQuery = Object.keys(scopeFilter).length > 0
      ? { $and: [nameMatch, scopeFilter] }
      : nameMatch;
    const blacklisted = await Blacklist.findOne(blackQuery)
      .collation({ locale: 'en', strength: 2 }).lean();
    if (blacklisted) {
      await interaction.editReply({
        content: `⚠️ **${name}** is currently blacklisted (entry: **${blacklisted.name}**).\nRemove the blacklist entry first before trusting.`,
      });
      return;
    }

    await TrustedUser.create({
      name,
      reason,
      addedByUserId: userId,
      addedByTag: interaction.user.tag,
    });

    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Trusted — Entry Added')
      .addFields(
        { name: 'Name', value: `[${name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: reason || 'N/A', inline: true },
        { name: 'Added by', value: interaction.user.tag, inline: true },
      )
      .setColor(0x57d6a1)
      .setFooter({ text: 'This character (and its alts) cannot be blacklisted' })
      .setTimestamp(new Date());

    await interaction.editReply({
      content: `🛡️ Added **${name}** to the trusted list.`,
      embeds: [embed],
    });

    console.log(`[list] Trusted user added: ${name} by ${interaction.user.tag}`);
  }

  return {
    handleListCheckCommand,
    handleListAddCommand,
    handleListEditCommand,
    handleListRemoveCommand,
    handleListViewCommand,
    handleListTrustCommand,
    handleListAddApprovalButton,
    handleListAddOverwriteButton,
    handleQuickAddSelect,
    handleQuickAddModal,
  };
}
