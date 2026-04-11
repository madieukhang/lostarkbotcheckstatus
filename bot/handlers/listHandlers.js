import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
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
import { buildBlacklistQuery, getGuildConfig } from '../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../utils/alertEmbed.js';
import { rehostImage, resolveDisplayImageUrl } from '../utils/imageRehost.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../utils/multiaddTemplate.js';

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
 * Wraps the shared buildAlertEmbed with severity:'trusted' so trusted
 * blocks have consistent styling with the rest of the bot's alerts.
 */
function buildTrustedBlockEmbed(name, reason, { via } = {}) {
  const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
  const description = via
    ? `**${name}** shares a roster with trusted user **${via}** and cannot be added to any list.`
    : `**${name}** is a trusted user and cannot be added to any list.`;

  return buildAlertEmbed({
    severity: AlertSeverity.TRUSTED,
    title: 'Trusted User — Blocked',
    description,
    fields: [
      { name: 'Name', value: `[${name}](${rosterLink})`, inline: true },
      { name: 'Trust reason', value: reason || 'N/A', inline: true },
    ],
  });
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

/**
 * Stricter variant used by /list multiadd auto-approve check.
 * Only senior + officer can bypass bulk approval; MEMBER_APPROVER_IDS
 * (which gives bypass rights on single /list add for legacy reasons)
 * does NOT confer bulk-add auto-approval. This matches the README claim
 * that only officers/seniors auto-approve multiadd batches.
 */
function isOfficerOrSenior(userId) {
  if (!userId) return false;
  if (SENIOR_APPROVER_IDS.includes(userId)) return true;
  return OFFICER_APPROVER_IDS.includes(userId);
}

/**
 * Senior-only recipient list for /list multiadd bulk approval DMs.
 * Unlike getApproverRecipientIds (which mixes in a random officer), this
 * returns exclusively SENIOR_APPROVER_IDS — bulk batches are a high-impact
 * operation that should always be reviewed by a Senior.
 */
function getSeniorApproverIds() {
  const seen = new Set();
  const out = [];
  for (const id of SENIOR_APPROVER_IDS) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
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
  // ---------- /list multiadd in-memory pending store ----------
  // Keyed by requestId, stores parsed-but-not-yet-confirmed bulk add data.
  // Entries auto-expire after MULTIADD_PENDING_TTL_MS to avoid stale state
  // across bot restarts — on restart this Map is empty and users re-upload.
  const MULTIADD_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const multiaddPending = new Map();

  /** Remove a pending multiadd request and any pending expiry timer. */
  function clearMultiaddPending(requestId) {
    const entry = multiaddPending.get(requestId);
    if (entry?.expiryTimer) clearTimeout(entry.expiryTimer);
    multiaddPending.delete(requestId);
  }

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

  /**
   * Send a bulk multiadd batch to approvers for review. Parallel to
   * sendListAddApprovalToApprovers but for /list multiadd batches — each
   * approver gets one DM with the full preview + approve/reject buttons.
   *
   * @param {Guild} guild - origin guild
   * @param {Object} pending - { requestId, rows, requesterId, requesterDisplayName, ... }
   */
  async function sendBulkApprovalToApprovers(guild, pending) {
    // Senior-only: bulk batches are high-impact and must always be reviewed by
    // a Senior, not a random officer (unlike single /list add which picks one).
    const approverIds = getSeniorApproverIds();
    if (approverIds.length === 0) {
      return {
        success: false,
        reason: 'No Senior approver user IDs configured. Set SENIOR_APPROVER_IDS in env.',
      };
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`multiaddapprove_approve:${pending.requestId}`)
        .setLabel(`Approve — Add ${pending.rows.length}`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`multiaddapprove_reject:${pending.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('✖️')
    );

    const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');
    const previewLines = pending.rows.slice(0, 20).map((r, i) => {
      const reasonShort = (r.reason || '').length > 40 ? (r.reason || '').slice(0, 37) + '...' : (r.reason || '');
      const scopeTag = r.scope === 'server' ? ' `[S]`' : '';
      return `\`${String(i + 1).padStart(2, ' ')}.\` ${typeIcon(r.type)} **${r.name}**${scopeTag} — ${reasonShort}`;
    });
    if (pending.rows.length > 20) {
      previewLines.push(`*... and ${pending.rows.length - 20} more rows*`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`📋 Bulk Add Approval — ${pending.rows.length} rows`)
      .setDescription(previewLines.join('\n').slice(0, 4000))
      .setColor(0x5865f2)
      .addFields(
        {
          name: 'Requested by',
          value: `${pending.requesterDisplayName || pending.requesterTag || 'Unknown'} (<@${pending.requesterId}>)`,
          inline: false,
        },
        {
          name: 'Server',
          value: guild?.name || pending.guildId || 'Unknown',
          inline: true,
        },
      )
      .setFooter({ text: `Request ID: ${pending.requestId.slice(0, 8)}` })
      .setTimestamp(new Date());

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
          console.warn(`[multiadd] Failed to DM approver ${approverId}:`, err.message);
        }
      })
    );

    if (deliveredApproverIds.length === 0) {
      return {
        success: false,
        reason: 'Unable to DM configured approvers. Check user IDs/privacy settings.',
      };
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
    {
      const trustedExact = await TrustedUser.findOne({ name })
        .collation({ locale: 'en', strength: 2 }).lean();
      if (trustedExact) {
        return {
          ok: false,
          content: `🛡️ **${name}** is a trusted user and cannot be added to any list.`,
          embeds: [buildTrustedBlockEmbed(name, trustedExact.reason)],
        };
      }
    }

    // Step 1: Check if character exists
    const { hasValidRoster, allCharacters, targetItemLevel } = await buildRosterCharacters(name);
    if (!hasValidRoster) {
      const suggestions = await fetchNameSuggestions(name) || [];
      if (suggestions.length > 0) {
        const suggestionLines = suggestions
          .slice(0, 10)
          .map(
            (s, idx) =>
              `**${idx + 1}.** [${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel || 0).toFixed(2)}\` — ${getClassName(s.cls)}`
          )
          .join('\n');

        return {
          ok: false,
          content: `❌ No roster found for **${name}**. Use one of the suggested names.`,
          embeds: [
            buildAlertEmbed({
              severity: AlertSeverity.ERROR,
              title: 'No Roster Found',
              description: `No character named **${name}** was found on lostark.bible. Here are some similar names:`,
              fields: [
                { name: 'Suggestions', value: suggestionLines.slice(0, 1024), inline: false },
              ],
              footer: 'Pick one of the suggested names and re-run the command.',
            }),
          ],
        };
      }

      return {
        ok: false,
        content: `❌ No roster found for **${name}**. No similar names found.`,
        embeds: [
          buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'No Roster Found',
            description: `No character named **${name}** was found on lostark.bible, and no similar names were suggested.`,
            footer: 'Check the spelling (Lost Ark names are case-sensitive and include diacritics).',
          }),
        ],
      };
    }

    // Step 2: Check ilvl >= 1700 (using exact ilvl from roster, not regex on HTML)
    if (targetItemLevel !== null && targetItemLevel < 1700) {
      return {
        ok: false,
        content: `❌ **${name}** has item level \`${targetItemLevel.toFixed(2)}\` (below 1700). Cannot add to ${label}.`,
        embeds: [
          buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'Item Level Too Low',
            description: `**${name}** does not meet the minimum item level required to be added to any list.`,
            fields: [
              { name: 'Character', value: `[${name}](https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster)`, inline: true },
              { name: 'Item level', value: `\`${targetItemLevel.toFixed(2)}\``, inline: true },
              { name: 'Minimum required', value: '`1700.00`', inline: true },
              { name: 'Target list', value: labelCap, inline: true },
            ],
            footer: 'ilvl gate prevents spam entries for inactive or unleveled alts.',
          }),
        ],
      };
    }

    // Step 2b: Trusted user guard (alt check — after roster gives us allCharacters)
    if (allCharacters.length > 0) {
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

      // Build structured alert embed with all the duplicate's context
      const existedRosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(existed.name)}/roster`;
      const dupFields = [];
      if (isRosterMatch) {
        dupFields.push({
          name: 'Match type',
          value: 'Roster alt',
          inline: true,
        });
        dupFields.push({
          name: 'Matched name',
          value: `[${existed.name}](${existedRosterLink})`,
          inline: true,
        });
      } else {
        dupFields.push({
          name: 'Match type',
          value: 'Exact name',
          inline: true,
        });
      }
      if (existed.scope) {
        dupFields.push({
          name: 'Scope',
          value: existed.scope === 'server' ? '`[Server]`' : '`[Global]`',
          inline: true,
        });
      }
      if (existed.addedByDisplayName || existed.addedByTag) {
        dupFields.push({
          name: 'Added by',
          value: existed.addedByDisplayName || existed.addedByTag,
          inline: true,
        });
      }
      if (existed.reason) {
        dupFields.push({
          name: 'Existing reason',
          value: existed.reason.slice(0, 1024),
          inline: false,
        });
      }
      if (existed.raid) {
        dupFields.push({
          name: 'Raid',
          value: existed.raid,
          inline: true,
        });
      }

      const dupDescription = isRosterMatch
        ? `**${name}** is already in ${label} via roster match with **${existed.name}**.`
        : `**${name}** is already in ${label}.`;

      return {
        ok: false,
        isDuplicate: true,
        existingEntry: existed,
        content: `⚠️ **${name}** already exists in ${label}.${via}${scopeNote}`,
        embeds: [
          buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: `Already in ${labelCap}`,
            description: dupDescription,
            fields: dupFields,
            footer: `Use /list view ${payload.type} to see the full entry, or /list edit to modify it.`,
          }),
        ],
      };
    }

    // Step 4: Create entry
    const createData = {
      name,
      reason: payload.reason,
      raid: payload.raid,
      logsUrl: payload.logsUrl || '',
      // Image storage: prefer rehosted (permanent) over direct URL (legacy/expiring)
      imageUrl: payload.imageMessageId ? '' : (payload.imageUrl || ''),
      imageMessageId: payload.imageMessageId || '',
      imageChannelId: payload.imageChannelId || '',
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

    // Global: broadcast to all opted-in servers
    // Server-scoped: broadcast only to owner guild (special privilege)
    // skipBroadcast: used by /list multiadd bulk flow to gather one summary broadcast instead of N spam
    if (!payload.skipBroadcast) {
      broadcastListChange('added', entry, payload, { onlyOwner: entryScope === 'server' }).catch((err) =>
        console.warn('[list] Broadcast failed:', err.message)
      );
    }

    return {
      ok: true,
      entry, // Mongoose doc for callers that need to re-use the created entry (e.g. bulk broadcast)
      content: `${icon} Added **${entry.name}** to ${label}.${scopeTag ? ' *(server only)*' : ''}`,
      embeds: [embed],
    };
  }

  async function broadcastListChange(action, entry, payload, options = {}) {
    const { onlyOwner = false } = options;
    const { label, color, icon } = getListContext(payload.type);
    const addedBy = payload.requestedByDisplayName || payload.requestedByTag || 'Unknown';
    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;

    // Capitalize label for title (blacklist → Blacklist)
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const actionCap = action.charAt(0).toUpperCase() + action.slice(1);
    const scopeTag = entry.scope === 'server' ? ' (Local)' : '';

    const embed = new EmbedBuilder()
      .setTitle(`📢 ${icon} ${labelCap}${scopeTag} — ${actionCap}`)
      .addFields(
        { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: entry.reason || 'N/A', inline: true },
      )
      .setColor(color)
      .setTimestamp(new Date());

    if (entry.raid) embed.addFields({ name: 'Raid', value: entry.raid, inline: true });

    // Resolve display URL via rehost-aware helper: prefers freshly-fetched
    // URL from evidence channel, falls back to legacy entry.imageUrl.
    // We also accept payload.imageUrl as a hot-path shortcut for entries we
    // JUST created (still fresh in this function call).
    const displayUrl = payload.imageUrl
      || (await resolveDisplayImageUrl(entry, client));
    if (displayUrl) embed.setImage(displayUrl);

    // Delegate channel routing to the shared resolver — keeps single-add and
    // bulk-add broadcast paths using identical scope/opt-out logic.
    const channelIds = await resolveBroadcastChannels(payload.guildId || '', { onlyOwner });
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

  /**
   * Resolve broadcast target channels for a given origin guild.
   * Returns a Set of channel IDs to send to, honoring opt-outs and scope.
   * Factored out of broadcastListChange so bulk broadcast can reuse it
   * without duplicating 40 lines of channel routing logic.
   */
  async function resolveBroadcastChannels(originGuildId, { onlyOwner = false } = {}) {
    const channelIds = new Set();

    if (onlyOwner) {
      if (!config.ownerGuildId) return channelIds;
      if (config.ownerGuildId === originGuildId) return channelIds;
      try {
        const ownerConfig = await GuildConfig.findOne({ guildId: config.ownerGuildId }).lean();
        if (ownerConfig?.globalNotifyEnabled === false) return channelIds;
        if (ownerConfig?.listNotifyChannelId) {
          channelIds.add(ownerConfig.listNotifyChannelId);
        } else {
          for (const envId of config.listNotifyChannelIds) {
            try {
              const ch = await client.channels.fetch(envId);
              if (ch?.guild?.id === config.ownerGuildId) {
                channelIds.add(envId);
                break;
              }
            } catch { /* skip */ }
          }
        }
      } catch (err) {
        console.warn('[list] Failed to query owner GuildConfig:', err.message);
      }
      return channelIds;
    }

    // Normal broadcast
    const disabledGuildIds = new Set();
    const dbNotifyGuildIds = new Set();
    try {
      const guildConfigs = await GuildConfig.find({}).lean();
      for (const gc of guildConfigs) {
        if (gc.globalNotifyEnabled === false) disabledGuildIds.add(gc.guildId);
        if (gc.listNotifyChannelId) dbNotifyGuildIds.add(gc.guildId);
        if (gc.guildId === originGuildId) continue;
        if (gc.globalNotifyEnabled === false) continue;
        if (!gc.listNotifyChannelId) continue;
        channelIds.add(gc.listNotifyChannelId);
      }
    } catch (err) {
      console.warn('[list] Failed to query GuildConfig for broadcast:', err.message);
    }

    if (config.listNotifyChannelIds.length > 0) {
      for (const envId of config.listNotifyChannelIds) {
        if (channelIds.has(envId)) continue;
        try {
          const ch = await client.channels.fetch(envId);
          if (!ch?.isTextBased()) continue;
          const chGuildId = ch.guild?.id || '';
          if (chGuildId === originGuildId) continue;
          if (disabledGuildIds.has(chGuildId)) continue;
          if (dbNotifyGuildIds.has(chGuildId)) continue;
          channelIds.add(envId);
        } catch { /* skip */ }
      }
    }

    return channelIds;
  }

  /**
   * Broadcast a single summary embed for a bulk multiadd batch.
   * Groups added entries by type (blacklist/whitelist/watchlist) and routes
   * global vs server-scoped entries separately.
   *
   * @param {Array<{ name, type, scope, entry }>} addedResults - rows from executeBulkMultiadd.added
   * @param {{ guildId, requestedByDisplayName }} meta
   */
  async function broadcastBulkAdd(addedResults, meta) {
    if (!addedResults || addedResults.length === 0) return;

    const globalEntries = addedResults.filter((r) => r.entry?.scope !== 'server');
    const serverEntries = addedResults.filter((r) => r.entry?.scope === 'server');

    const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');

    const buildBulkEmbed = (entries, isLocal) => {
      // Group by type so the embed is visually organized
      const grouped = { black: [], white: [], watch: [] };
      for (const r of entries) {
        const t = r.type || r.entry?.type || 'black';
        if (grouped[t]) grouped[t].push(r);
      }

      const embed = new EmbedBuilder()
        .setTitle(`📢 Bulk Add${isLocal ? ' (Local)' : ''} — ${entries.length} entries`)
        .setColor(0x5865f2)
        .setFooter({ text: `By ${meta.requestedByDisplayName || 'Unknown'}` })
        .setTimestamp(new Date());

      const typeLabels = { black: 'Blacklist', white: 'Whitelist', watch: 'Watchlist' };
      for (const t of ['black', 'white', 'watch']) {
        if (grouped[t].length === 0) continue;
        const lines = grouped[t]
          .slice(0, 15) // Discord embed field limit
          .map((r, i) => `${i + 1}. ${typeIcon(t)} **${r.name}** — ${(r.entry?.reason || '').slice(0, 80)}`)
          .join('\n');
        const suffix = grouped[t].length > 15 ? `\n*... and ${grouped[t].length - 15} more*` : '';
        embed.addFields({
          name: `${typeLabels[t]} (${grouped[t].length})`,
          value: (lines + suffix).slice(0, 1024),
        });
      }

      return embed;
    };

    const originGuildId = meta.guildId || '';

    // Global broadcast — all opted-in guilds
    if (globalEntries.length > 0) {
      const channelIds = await resolveBroadcastChannels(originGuildId, { onlyOwner: false });
      if (channelIds.size > 0) {
        const embed = buildBulkEmbed(globalEntries, false);
        await Promise.all(
          [...channelIds].map(async (channelId) => {
            try {
              const channel = await client.channels.fetch(channelId);
              if (channel?.isTextBased()) {
                await channel.send({ embeds: [embed] });
              }
            } catch (err) {
              console.warn(`[multiadd] Bulk broadcast to ${channelId} failed:`, err.message);
            }
          })
        );
      }
    }

    // Server-scoped broadcast — owner guild only
    if (serverEntries.length > 0) {
      const channelIds = await resolveBroadcastChannels(originGuildId, { onlyOwner: true });
      if (channelIds.size > 0) {
        const embed = buildBulkEmbed(serverEntries, true);
        await Promise.all(
          [...channelIds].map(async (channelId) => {
            try {
              const channel = await client.channels.fetch(channelId);
              if (channel?.isTextBased()) {
                await channel.send({ embeds: [embed] });
              }
            } catch (err) {
              console.warn(`[multiadd] Bulk local broadcast to ${channelId} failed:`, err.message);
            }
          })
        );
      }
    }
  }

  /**
   * Execute a bulk multiadd batch by looping rows through executeListAddToDatabase
   * with skipBroadcast=true. Handles per-row errors so one bad row doesn't kill
   * the whole batch. Resolves default scope from guild config once for the batch.
   *
   * @param {Array} rows - parsed rows from parseMultiaddFile
   * @param {Object} meta - { guildId, channelId, requesterId, requesterTag, requesterDisplayName }
   * @param {Function} [onProgress] - called as (currentIndex, total) periodically
   * @returns {Promise<{ added: Array, skipped: Array, failed: Array }>}
   */
  async function executeBulkMultiadd(rows, meta, onProgress = null) {
    const results = { added: [], skipped: [], failed: [] };

    // Pre-resolve guild default scope once (cached by getGuildConfig)
    let guildDefaultScope = 'global';
    try {
      await connectDB();
      const gc = await getGuildConfig(meta.guildId);
      guildDefaultScope = gc?.defaultBlacklistScope || 'global';
    } catch (err) {
      console.warn('[multiadd] Failed to resolve guild default scope:', err.message);
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Resolve effective scope for this row:
      //   - non-blacklist: always 'global' (whitelist/watchlist don't use scope)
      //   - blacklist with explicit scope: honor it
      //   - blacklist without scope: fall back to guild default
      const effectiveScope =
        row.type === 'black' ? (row.scope || guildDefaultScope) : 'global';

      // Rehost the row's image URL (if any) so the entry has permanent storage.
      // Best-effort: rehost failure falls back to legacy URL storage. Fetched
      // sequentially with the row processing because each rehost is small.
      let rowRehost = null;
      if (row.image) {
        rowRehost = await rehostImage(row.image, client, {
          entryName: row.name,
          addedBy: meta.requesterDisplayName || meta.requesterTag,
          listType: row.type,
        });
      }

      const payload = {
        requestId: randomUUID(),
        guildId: meta.guildId,
        channelId: meta.channelId,
        type: row.type,
        name: row.name,
        reason: row.reason,
        raid: row.raid || '',
        logsUrl: row.logs || '',
        imageUrl: rowRehost?.freshUrl || row.image || '',
        imageMessageId: rowRehost?.messageId || '',
        imageChannelId: rowRehost?.channelId || '',
        scope: effectiveScope,
        requestedByUserId: meta.requesterId,
        requestedByTag: meta.requesterTag || '',
        requestedByName: meta.requesterName || '',
        requestedByDisplayName: meta.requesterDisplayName || '',
        createdAt: Date.now(),
        skipBroadcast: true, // bulk uses a single aggregated broadcast at the end
      };

      try {
        const result = await executeListAddToDatabase(payload);
        if (result.ok) {
          results.added.push({
            name: row.name,
            type: row.type,
            scope: effectiveScope,
            entry: result.entry,
          });
        } else if (result.isDuplicate) {
          results.skipped.push({
            name: row.name,
            reason: 'duplicate (already in list)',
          });
        } else {
          // Strip Discord markdown and trim for summary embed
          const firstLine = (result.content || 'unknown error').split('\n')[0];
          const plain = firstLine.replace(/\*\*/g, '').replace(/[⚠️❌🛡️⛔✅]/g, '').trim();
          results.skipped.push({
            name: row.name,
            reason: plain.slice(0, 80),
          });
        }
      } catch (err) {
        console.error(`[multiadd] Row ${row.rowNum} "${row.name}" failed:`, err);
        results.failed.push({
          name: row.name,
          error: err.message || 'unknown error',
        });
      }

      // Progress callback after each row (caller decides cadence)
      if (onProgress) {
        try {
          await onProgress(i + 1, rows.length);
        } catch { /* progress errors shouldn't stop the batch */ }
      }

      // Throttle to avoid hammering lostark.bible and Discord API
      if (i < rows.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    return results;
  }

  /**
   * Build the final summary embed shown after a bulk multiadd completes.
   * Used by both direct execution (officer path) and approval path.
   */
  function buildBulkSummaryEmbed(results, meta) {
    const totalAttempted = results.added.length + results.skipped.length + results.failed.length;
    const hasFailures = results.failed.length > 0;
    const color = hasFailures ? 0xfee75c : results.added.length > 0 ? 0x57f287 : 0xed4245;

    const embed = new EmbedBuilder()
      .setTitle('📋 Bulk Add Complete')
      .setDescription(`Processed **${totalAttempted}** row${totalAttempted === 1 ? '' : 's'}`)
      .setColor(color)
      .addFields(
        { name: '✅ Added', value: String(results.added.length), inline: true },
        { name: '⚠️ Skipped', value: String(results.skipped.length), inline: true },
        { name: '❌ Failed', value: String(results.failed.length), inline: true },
      )
      .setFooter({ text: `By ${meta.requesterDisplayName || 'Unknown'}` })
      .setTimestamp(new Date());

    const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');

    if (results.added.length > 0) {
      const addedLines = results.added
        .slice(0, 15)
        .map((r, i) => `${i + 1}. ${typeIcon(r.type)} **${r.name}**`)
        .join('\n');
      const suffix = results.added.length > 15 ? `\n*... and ${results.added.length - 15} more*` : '';
      embed.addFields({
        name: `Added (${results.added.length})`,
        value: (addedLines + suffix).slice(0, 1024),
      });
    }

    if (results.skipped.length > 0) {
      const skippedLines = results.skipped
        .slice(0, 10)
        .map((r) => `• **${r.name}** — ${r.reason}`)
        .join('\n');
      const suffix = results.skipped.length > 10 ? `\n*... and ${results.skipped.length - 10} more*` : '';
      embed.addFields({
        name: `Skipped (${results.skipped.length})`,
        value: (skippedLines + suffix).slice(0, 1024),
      });
    }

    if (results.failed.length > 0) {
      const failedLines = results.failed
        .slice(0, 10)
        .map((r) => `• **${r.name}** — ${r.error}`)
        .join('\n');
      const suffix = results.failed.length > 10 ? `\n*... and ${results.failed.length - 10} more*` : '';
      embed.addFields({
        name: `Failed (${results.failed.length})`,
        value: (failedLines + suffix).slice(0, 1024),
      });
    }

    return embed;
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
            ...(payload.type === 'black' ? { scope: payload.scope || existingEntry.scope || 'global', guildId: (payload.scope || existingEntry.scope || 'global') === 'server' ? (payload.guildId || '') : '' } : {}),
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

        // Broadcast edit: global to all, server-scoped to owner only
        const entryScope = existingEntry.scope || payload.scope || 'global';
        broadcastListChange('edited', { ...existingEntry.toObject?.() || existingEntry, reason: payload.reason || existingEntry.reason, raid: payload.raid || existingEntry.raid }, {
          type: payload.type,
          guildId: payload.guildId,
          requestedByDisplayName: payload.requestedByDisplayName,
          requestedByTag: payload.requestedByTag,
        }, { onlyOwner: entryScope === 'server' }).catch(() => {});

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

  async function handleListRemoveCommand(interaction) {
    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    try {
      await connectDB();

      const removeGuildId = interaction.guild?.id || '';
      const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
        Blacklist.findOne(buildBlacklistQuery({ $or: [{ name }, { allCharacters: name }] }, removeGuildId))
          .sort({ scope: -1 })
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

        // Global: broadcast to all. Server-scoped: broadcast to owner only
        broadcastListChange('removed', entry, {
          type,
          guildId: interaction.guild?.id || '',
          requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
          requestedByTag: interaction.user.tag,
        }, { onlyOwner: entry.scope === 'server' }).catch((err) => console.warn('[list] Broadcast failed:', err.message));

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

    await interaction.deferReply();
    await connectDB();

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
    // Server-scoped entries always auto-approve (local = no approval needed)
    const isOwner = existing.addedByUserId === interaction.user.id;
    const isApprover = isRequesterAutoApprover(interaction.user.id);
    const existingObj = existing.toObject?.() || existing;
    // Local auto-approve only for blacklist entries that are server-scoped,
    // or edits moving to blacklist where target scope is server.
    // White/watch have no scope — never auto-approve via this rule.
    const isBlacklistLocal = currentType === 'black' && existingObj.scope === 'server';
    const isMovingToLocalBlack = isTypeChange && targetType === 'black' && editGuildDefaultScope === 'server';
    const isLocalScope = isBlacklistLocal || isMovingToLocalBlack;

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

          await newModel.create({
            name: existing.name,
            reason: newReason || existing.reason,
            raid: newRaid || existing.raid,
            logsUrl: newLogs || existing.logsUrl,
            ...moveImageFields,
            allCharacters: existing.allCharacters || [],
            addedByUserId: existing.addedByUserId,
            addedByTag: existing.addedByTag,
            addedByDisplayName: existing.addedByDisplayName,
            addedAt: existing.addedAt,
            ...(targetType === 'black' ? (() => {
              // Resolve scope: keep existing if blacklist→blacklist, else use guild default
              const moveScope = existingObj.scope || editGuildDefaultScope;
              return { scope: moveScope, guildId: moveScope === 'server' ? editGuildId : '' };
            })() : {}),
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
        scope: existingObj.scope || editGuildDefaultScope, // preserve existing scope, or use guild default
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
              scopeLabel = ` (Local: ${gName})`;
            } else {
              scopeLabel = ' (Local)';
            }
          }
          const parts = [`${e._icon} **${e.name}**${scopeLabel}`];
          if (e.reason) parts.push(e.reason);
          if (e.raid) parts.push(`[${e.raid}]`);
          const date = e.addedAt ? `<t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>` : '';
          if (date) parts.push(date);
          // 📎 inline evidence link:
          //   - Rehosted entries → link to evidence message in owner guild
          //     (Discord deep-link, opens the message inline in Discord client)
          //   - Legacy entries → link to original CDN URL (may be expired)
          //   - Either way, the "Evidence" select dropdown below also works
          //     and uses lazy refresh for guaranteed-fresh URLs.
          if (e.imageMessageId && e.imageChannelId && config.ownerGuildId) {
            const msgLink = `https://discord.com/channels/${config.ownerGuildId}/${e.imageChannelId}/${e.imageMessageId}`;
            parts.push(`[📎](${msgLink})`);
          } else if (e.imageUrl) {
            parts.push(`[📎](${e.imageUrl})`);
          }
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

        // Evidence dropdown for entries with images on current page.
        // Includes both legacy (imageUrl) and rehosted (imageMessageId) entries.
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);
        const withImages = pageEntries.filter((e) => e.imageUrl || e.imageMessageId);

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

          // Check if entry has ANY image source: rehosted or legacy
          const hasAnyImage = entry?.imageMessageId || entry?.imageUrl;
          if (!hasAnyImage) {
            await i.reply({ content: 'No evidence image for this entry.', ephemeral: true });
            return;
          }

          // Resolve fresh URL via rehost-aware helper. For rehosted entries
          // this fetches a fresh signed URL from the evidence channel; for
          // legacy entries it returns the (possibly expired) stored URL.
          const displayUrl = await resolveDisplayImageUrl(entry, client);

          const embed = new EmbedBuilder()
            .setTitle(`${entry._icon} ${entry.name}`)
            .addFields(
              { name: 'Reason', value: entry.reason || 'N/A', inline: true },
              { name: 'Raid', value: entry.raid || 'N/A', inline: true },
              { name: 'List', value: entry._label, inline: true },
            )
            .setColor(entry._color)
            .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

          if (displayUrl) {
            embed.setImage(displayUrl);
          } else {
            embed.addFields({
              name: '⚠️ Evidence',
              value: 'Image link expired or unavailable. Re-add evidence via `/list edit`.',
              inline: false,
            });
          }

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
      // Resolve scope from guild default setting
      let quickScope = 'global';
      if (type === 'black' && interaction.guild?.id) {
        await connectDB();
        const gc = await getGuildConfig(interaction.guild.id);
        quickScope = gc?.defaultBlacklistScope || 'global';
      }

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
        scope: quickScope,
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        createdAt: Date.now(),
      };

      // Auto-approve: officers always, OR server-scoped (local = free)
      if (isRequesterAutoApprover(payload.requestedByUserId) || payload.scope === 'server') {
        const result = await executeListAddToDatabase(payload);
        const hasEmbed = (result.embeds?.length ?? 0) > 0;
        await interaction.editReply({
          content: hasEmbed ? null : result.content,
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
    const blacklisted = await Blacklist.findOne(
      buildBlacklistQuery({ $or: [{ name }, { allCharacters: name }] }, trustGuildId)
    ).collation({ locale: 'en', strength: 2 }).lean();
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
      .setFooter({ text: 'This character (and its alts) cannot be added to any list' })
      .setTimestamp(new Date());

    await interaction.editReply({
      content: `🛡️ Added **${name}** to the trusted list.`,
      embeds: [embed],
    });

    console.log(`[list] Trusted user added: ${name} by ${interaction.user.tag}`);
  }

  /**
   * /list multiadd action:<template|file> [file:<attachment>]
   *
   * Available to all guild members. Two actions:
   *   - template: sends blank .xlsx template as ephemeral attachment
   *   - file: (Phase 2+) downloads and parses filled template
   *
   * NOTE (Phase 3): non-officer/senior users uploading a file will route
   * the entire batch through a single bulk approval request to Senior.
   */
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
              '`/list multiadd action:file file:<your.xlsx>`'
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

  /**
   * Handle Confirm/Cancel button click from the /list multiadd preview.
   * Cancel drops the pending entry. Confirm (Phase 2 stub) shows a
   * placeholder; Phase 3 will replace with actual bulk add loop.
   */
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

        // Build simplified bulkRows shape for DB (matches schema)
        const bulkRows = pending.rows.map((r) => ({
          name: r.name,
          type: r.type,
          reason: r.reason,
          raid: r.raid || '',
          logsUrl: r.logs || '',
          imageUrl: r.image || '',
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

  /**
   * Handle Approve/Reject button click from a Senior's DM for a /list multiadd
   * batch. Loads the PendingApproval, validates approver permission, executes
   * the bulk add (on approve) or simply drops it (on reject), then notifies
   * the original requester in the origin channel.
   */
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

      // Re-hydrate rows from DB shape back to parser row shape (logs/image field names differ)
      const rows = payload.bulkRows.map((r) => ({
        name: r.name,
        type: r.type,
        reason: r.reason,
        raid: r.raid || '',
        logs: r.logsUrl || '',
        image: r.imageUrl || '',
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
    handleListCheckCommand,
    handleListAddCommand,
    handleListEditCommand,
    handleListRemoveCommand,
    handleListViewCommand,
    handleListTrustCommand,
    handleListMultiaddCommand,
    handleMultiaddConfirmButton,
    handleMultiaddApprovalButton,
    handleListAddApprovalButton,
    handleListAddOverwriteButton,
    handleQuickAddSelect,
    handleQuickAddModal,
  };
}
