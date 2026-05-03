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

import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../../db.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
} from '../../../services/rosterService.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
} from '../helpers.js';
import { createApprovalServices } from './approvals.js';
import { createBroadcastServices } from './broadcasts.js';
import { createBulkServices } from './bulk.js';

export function createSharedServices({ client }) {
  const {
    sendListAddApprovalToApprovers,
    sendBulkApprovalToApprovers,
    syncApproverDmMessages,
    notifyRequesterAboutDecision,
  } = createApprovalServices({ client });

  const {
    broadcastListChange,
    resolveBroadcastChannels,
    broadcastBulkAdd,
  } = createBroadcastServices({ client });

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
    const { hasValidRoster, allCharacters, targetItemLevel, rosterVisibility } = await buildRosterCharacters(name, {
      hiddenRosterFallback: true,
    });
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
            footer: `Use /la-list view ${payload.type} to see the full entry, or /la-list edit to modify it.`,
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
    const rosterSource = rosterVisibility === 'hidden' ? 'Hidden roster fallback' : 'Visible roster';
    const embed = new EmbedBuilder()
      .setTitle(`${labelCap}${scopeTag} — Entry Added`)
      .addFields(
        { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: payload.reason || 'N/A', inline: true },
        { name: 'Raid', value: payload.raid || 'N/A', inline: true },
        { name: `All Characters (${allCharacters.length})`, value: allCharsDisplay, inline: false },
        { name: 'Roster source', value: rosterSource, inline: true },
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
    // skipBroadcast: used by /la-list multiadd bulk flow to gather one summary broadcast instead of N spam
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

  const {
    executeBulkMultiadd,
    buildBulkSummaryEmbed,
  } = createBulkServices({ client, executeListAddToDatabase });

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
