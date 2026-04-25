/**
 * services.js
 *
 * Shared closure services used by every /list * command handler. All
 * functions close over the Discord `client`, so they live in a factory
 * that takes `{ client }` and returns the service object.
 *
 * Service responsibilities:
 *   - Approval DM dispatch + sync (sendListAddApprovalToApprovers,
 *     sendBulkApprovalToApprovers, syncApproverDmMessages)
 *   - Database persistence with all guards (executeListAddToDatabase)
 *   - Cross-guild broadcast (broadcastListChange, resolveBroadcastChannels,
 *     broadcastBulkAdd)
 *   - Bulk multiadd execution + summary (executeBulkMultiadd,
 *     buildBulkSummaryEmbed)
 *   - Requester notification on approval/reject (notifyRequesterAboutDecision)
 */

import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
} from '../../services/rosterService.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { getGuildConfig } from '../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { rehostImage, resolveDisplayImageUrl } from '../../utils/imageRehost.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  getApproverRecipientIds,
  getSeniorApproverIds,
  buildListAddApprovalEmbed,
} from './helpers.js';

export function createSharedServices({ client }) {
  async function sendListAddApprovalToApprovers(guild, payload, options = {}) {
    const approverIds = getApproverRecipientIds();
    if (approverIds.length === 0) {
      return { success: false, reason: 'No approver user IDs configured. Set SENIOR_APPROVER_IDS or OFFICER_APPROVER_IDS in env.' };
    }

    // The Approve/Reject buttons are persistent — DMs can sit unread for hours
    // or days. The View Evidence button (only when payload has any image)
    // resolves a freshly-signed URL on click so the approver can preview the
    // evidence even after the original embed image link has expired.
    const buttons = [
      new ButtonBuilder()
        .setCustomId(`listadd_approve:${payload.requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`listadd_reject:${payload.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    ];
    if (payload.imageMessageId || payload.imageUrl) {
      buttons.push(
        new ButtonBuilder()
          .setCustomId(`listadd_viewevidence:${payload.requestId}`)
          .setLabel('📎 View Evidence (Fresh)')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    const row = new ActionRowBuilder().addComponents(buttons);

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

    // Resolve the freshest possible image URL from the just-created entry.
    // payload.imageUrl is unsafe here because for approval-delayed adds the
    // payload was snapshotted >24h ago and its URL may be expired. Going
    // through resolveDisplayImageUrl() guarantees a freshly-signed URL from
    // the rehosted message at THIS moment, regardless of payload age.
    const freshDisplayUrl = await resolveDisplayImageUrl(entry, client);
    if (freshDisplayUrl) {
      embed.setImage(freshDisplayUrl);
    }

    // Global: broadcast to all opted-in servers
    // Server-scoped: broadcast only to owner guild (special privilege)
    // skipBroadcast: used by /list multiadd bulk flow to gather one summary broadcast instead of N spam
    if (!payload.skipBroadcast) {
      // Pass the already-resolved fresh URL so broadcastListChange does not
      // re-fetch the same evidence message a second time.
      broadcastListChange('added', entry, payload, {
        onlyOwner: entryScope === 'server',
        displayUrl: freshDisplayUrl,
      }).catch((err) =>
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
    const { onlyOwner = false, displayUrl: preResolvedUrl } = options;
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

    // Prefer pre-resolved URL from caller (executeListAddToDatabase passes
    // freshDisplayUrl to avoid double-fetching the same evidence message).
    // Otherwise resolve fresh from the entry. We deliberately avoid trusting
    // payload.imageUrl here because it may be a stale snapshot from an
    // approval-delayed payload.
    const displayUrl = preResolvedUrl !== undefined
      ? preResolvedUrl
      : await resolveDisplayImageUrl(entry, client);
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

    // Owner guild exemption: always include the owner guild in broadcast
    // targets even when it is the origin. The notify channel serves as an
    // audit log for the whole team, and skipping it when the command
    // originates from the owner server creates a gap in the log. Non-owner
    // guilds are still excluded when they are the origin to avoid duplicate
    // notifications (the command user already sees the reply in their
    // command channel, and for non-owner servers the notify channel is
    // often the same channel or close enough).
    const isOwnerOrigin = originGuildId === config.ownerGuildId;

    if (onlyOwner) {
      if (!config.ownerGuildId) return channelIds;
      // Owner guild's notify channel always receives broadcasts (even
      // when origin = owner) — audit log completeness. The old guard
      // `if (owner === origin) return` was removed for this reason.
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
        // Skip origin guild UNLESS it's the owner guild (audit log exemption).
        if (gc.guildId === originGuildId && !isOwnerOrigin) continue;
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
          // Skip origin guild UNLESS it's the owner guild.
          if (chGuildId === originGuildId && !isOwnerOrigin) continue;
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
    // rehostWarnings: rows where image was provided but rehostImage failed.
    // The entry still gets added (with legacy imageUrl) but the user should
    // know the image will expire in ~24h unless manually re-added.
    const results = { added: [], skipped: [], failed: [], rehostWarnings: [] };

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
      // Skip rehost if row already carries refs from a prior rehost (e.g.
      // member submit pre-rehosted before saving to PendingApproval). This
      // avoids re-downloading URLs that may have expired between submit
      // and Senior approval.
      let rowRehost = null;
      if (row.imageMessageId && row.imageChannelId) {
        rowRehost = {
          messageId: row.imageMessageId,
          channelId: row.imageChannelId,
          freshUrl: '', // not needed; persisted entry will refresh on display
        };
      } else if (row.image) {
        try {
          rowRehost = await rehostImage(row.image, client, {
            entryName: row.name,
            addedBy: meta.requesterDisplayName || meta.requesterTag,
            listType: row.type,
            throwOnError: true,
          });
        } catch (rehostErr) {
          // Rehost failed — entry will still be added but with a legacy
          // imageUrl that expires in ~24h. Track the failure so the summary
          // embed can warn the user. The entry itself is NOT considered
          // "failed" — only the image storage is degraded.
          results.rehostWarnings.push({
            name: row.name,
            error: rehostErr.message,
          });
          console.warn(`[multiadd] Row "${row.name}" image rehost failed:`, rehostErr.message);
          // rowRehost stays null → payload falls back to legacy imageUrl
        }
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

    // Rehost warnings: rows added successfully BUT their image could not be
    // rehosted to the evidence channel. The entries are stored with a legacy
    // imageUrl that will expire in ~24h. Surface these prominently so the
    // user knows to re-add images via /list edit if needed.
    if (results.rehostWarnings?.length > 0) {
      const warnLines = results.rehostWarnings
        .slice(0, 10)
        .map((r) => `• **${r.name}** — ${r.error}`)
        .join('\n');
      const suffix = results.rehostWarnings.length > 10
        ? `\n*... and ${results.rehostWarnings.length - 10} more*`
        : '';
      embed.addFields({
        name: `🖼️ Image rehost failed (${results.rehostWarnings.length})`,
        value: (
          warnLines + suffix +
          '\n*Entries added OK but images stored as legacy URLs — will expire in ~24h.*'
        ).slice(0, 1024),
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

  return {
    sendListAddApprovalToApprovers,
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    executeListAddToDatabase,
    broadcastListChange,
    resolveBroadcastChannels,
    broadcastBulkAdd,
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
    notifyRequesterAboutDecision,
  };
}
