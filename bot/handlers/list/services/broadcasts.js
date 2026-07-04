/**
 * handlers/list/services/broadcasts.js
 * Cross-guild broadcast helpers · posts list-change notifications to
 * the per-guild notify channel (configured via /la-setup notifychannel
 * or LIST_NOTIFY_CHANNEL_IDS env fallback). Also exports the tracked-
 * alts field builder and roster stat-record merge helpers reused by
 * the multiadd reject/summary embeds.
 */

import { EmbedBuilder } from 'discord.js';

import config from '../../../config.js';
import GuildConfig from '../../../models/GuildConfig.js';
import RosterSnapshot from '../../../models/RosterSnapshot.js';
import { getClassEmoji, getClassName } from '../../../models/Class.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import { COLORS, ICONS, relativeTime } from '../../../utils/ui.js';
import { getListContext, listTypeIcon } from '../helpers.js';
import {
  formatAltLine,
  renderTrackedAltsField,
} from '../trackedAltsRender.js';

const ACTION_VERB = Object.freeze({
  added:   'added to',
  removed: 'removed from',
  edited:  'edited in',
  // 'enriched' uses a bespoke headline (see broadcastListChange) that names the
  // new-alt count instead of the generic "was <verb> <list>" phrasing; the verb
  // here only feeds the card title ("List enriched broadcast").
  enriched: 'enriched',
});

function normalizeNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parseItemLevel(value) {
  const parsed = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeCombatScore(value) {
  const text = String(value || '').trim();
  return text && text !== '?' ? text : '';
}

function normalizeRosterStatRecord(record) {
  const name = String(record?.name || '').trim();
  if (!name) return null;
  return {
    name,
    classId: String(record?.classId || '').trim(),
    className: String(record?.className || '').trim(),
    itemLevel: parseItemLevel(record?.itemLevel),
    combatScore: normalizeCombatScore(record?.combatScore),
  };
}

export function mergeRosterStatRecords(records = [], baseMap = new Map()) {
  for (const record of records || []) {
    const normalized = normalizeRosterStatRecord(record);
    if (!normalized) continue;
    baseMap.set(normalizeNameKey(normalized.name), normalized);
  }
  return baseMap;
}

function getBroadcastClassName(record) {
  if (!record) return '';
  return record.className || (record.classId ? getClassName(record.classId) : '');
}

// formatBroadcastCharacterLine + buildTrackedAltsField are kept as thin
// wrappers around the shared renderer in handlers/list/trackedAltsRender.js
// so the broadcast-specific public API (which tests import) stays stable
// while the actual rendering logic lives in one place. Numbering changed
// from "1." plain to "**1.**" bold to match the shared renderer's
// formatting · cross-server broadcasts now read identically to the
// /la-list view evidence detail card.

export const formatBroadcastCharacterLine = formatAltLine;

export function buildTrackedAltsField(entry, statMap = new Map()) {
  return renderTrackedAltsField({
    names: entry?.allCharacters,
    primaryName: entry?.name,
    statMap,
  });
}

/**
 * Build the broadcast service bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   used to resolve the configured notify channels and post the
 *   change embed.
 * @returns {{
 *   broadcastListChange: Function,
 *   resolveBroadcastChannels: Function,
 *   broadcastBulkAdd: Function,
 * }}
 */
export function createBroadcastServices({ client }) {
  async function broadcastListChange(action, entry, payload, options = {}) {
    const {
      onlyOwner = false,
      displayUrl: preResolvedUrl,
      rosterCharacters = [],
      newAltNames = [],
    } = options;
    const isEnrich = action === 'enriched';
    const { label, color, icon } = getListContext(payload.type);
    const rosterLink = rosterUrl(entry.name);

    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const verb = ACTION_VERB[action] || action;
    const scopeTag = entry.scope === 'server' ? ' `[Local]`' : '';

    // RosterSnapshot enrichment for class icon + ilvl + CP. Best-effort:
    // if /la-roster has queried this name before, the broadcast carries
    // the same rich vocabulary as the v0.5.67 OCR check / scan cards.
    // Otherwise fall back to the older name-only headline.
    const allChars = Array.isArray(entry.allCharacters) ? entry.allCharacters : [];
    const lookupNames = [...new Set([entry.name, ...allChars].filter(Boolean))];
    let statMap = new Map();
    try {
      const snaps = await RosterSnapshot.find({ name: { $in: lookupNames } })
        .collation({ locale: 'en', strength: 2 })
        .lean();
      statMap = mergeRosterStatRecords(snaps);
    } catch (err) {
      console.warn('[list] Snapshot lookup for broadcast failed (non-fatal):', err.message);
    }
    mergeRosterStatRecords(rosterCharacters, statMap);

    const snap = statMap.get(normalizeNameKey(entry.name)) || null;
    const className = getBroadcastClassName(snap);
    const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';

    // Description leads with a one-line headline so the recipient
    // sees "What changed in which list" without parsing the fields.
    // Class icon (when known) sits between the list-status icon and
    // the linked name to match the rest of the v0.5.67 vocabulary.
    // Enrich gets a bespoke headline naming the new-alt count + running
    // total (deliberately does NOT name the officer who ran it - the
    // guild only needs to know the entry grew, not by whom).
    const newAlts = (Array.isArray(newAltNames) ? newAltNames : []).filter(Boolean);
    const newCount = newAlts.length;
    const totalTracked = Math.max(0, allChars.filter((n) => normalizeNameKey(n) !== normalizeNameKey(entry.name)).length);
    const headline = isEnrich
      ? `${icon} ${classPrefix}**[${entry.name}](${rosterLink})** gained **${newCount}** new tracked alt${newCount === 1 ? '' : 's'} in **${labelCap}**${scopeTag} via enrich · now **${totalTracked}** tracked.`
      : `${icon} ${classPrefix}**[${entry.name}](${rosterLink})** was ${verb} **${labelCap}**${scopeTag}.`;

    const fields = [
      { name: '📝 Reason', value: (entry.reason || 'N/A').slice(0, 1024), inline: false },
    ];
    if (entry.raid) fields.push({ name: '🗡️ Raid', value: `\`${entry.raid}\``, inline: true });
    if (entry.addedAt) {
      // enrich shows the original add time (how long they've been listed) under
      // the same "Added" label as the add card; only manual edits say "Edited".
      fields.push({
        name: action === 'edited' ? '🕐 Edited' : '🕐 Added',
        value: relativeTime(entry.addedAt),
        inline: true,
      });
    }
    // Roster stats from the snapshot lookup above. Both fields share
    // the same `if snap` gate because RosterSnapshot writes ilvl + CP
    // together; one without the other is unexpected. Inline with the
    // existing meta so the card stays compact.
    if (snap?.itemLevel > 0) {
      fields.push({
        name: '📊 ilvl',
        value: `\`${snap.itemLevel.toFixed(2)}\``,
        inline: true,
      });
    }
    if (snap?.combatScore) {
      fields.push({
        name: '⚔️ CP',
        value: snap.combatScore,
        inline: true,
      });
    }

    // Roster (allCharacters) field. Cross-server recipients of this
    // broadcast haven't run /la-list view themselves, so seeing the
    // full alt list inline saves them a lookup when deciding whether
    // someone in their guild is the same account. Capped at 12 visible
    // names with a `+N more` overflow line; rich rows are trimmed
    // dynamically so the field stays under Discord's 1024-char limit.
    // Non-enrich: full tracked-alts roster. Enrich: only the alts THIS scan
    // just appended (label swapped to "🆕 New alts"), rendered through the same
    // renderer so class icon + ilvl match the add card exactly. The new alts'
    // class/ilvl ride in via options.rosterCharacters (the enrich session
    // carries {name, classId, itemLevel}); RosterSnapshot may not have them yet.
    if (isEnrich) {
      const newAltsField = renderTrackedAltsField({
        names: newAlts,
        primaryName: entry.name,
        statMap,
        label: '🆕 New alts',
      });
      if (newAltsField) fields.push(newAltsField);
    } else {
      const trackedAltsField = buildTrackedAltsField(entry, statMap);
      if (trackedAltsField) fields.push(trackedAltsField);
    }

    const embed = new EmbedBuilder()
      .setTitle(`${ICONS.dm} List ${verb.split(' ')[0]} broadcast`)
      .setDescription(headline)
      .addFields(fields)
      .setColor(color)
      .setTimestamp(new Date());

    const displayUrl = preResolvedUrl !== undefined
      ? preResolvedUrl
      : await resolveDisplayImageUrl(entry, client);
    if (displayUrl) embed.setImage(displayUrl);

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

  async function resolveBroadcastChannels(originGuildId, { onlyOwner = false } = {}) {
    const channelIds = new Set();
    const isOwnerOrigin = originGuildId === config.ownerGuildId;

    if (onlyOwner) {
      if (!config.ownerGuildId) return channelIds;
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

    const disabledGuildIds = new Set();
    const dbNotifyGuildIds = new Set();
    try {
      const guildConfigs = await GuildConfig.find({}).lean();
      for (const gc of guildConfigs) {
        if (gc.globalNotifyEnabled === false) disabledGuildIds.add(gc.guildId);
        if (gc.listNotifyChannelId) dbNotifyGuildIds.add(gc.guildId);
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
          if (chGuildId === originGuildId && !isOwnerOrigin) continue;
          if (disabledGuildIds.has(chGuildId)) continue;
          if (dbNotifyGuildIds.has(chGuildId)) continue;
          channelIds.add(envId);
        } catch { /* skip */ }
      }
    }

    return channelIds;
  }

  async function broadcastBulkAdd(addedResults, meta) {
    if (!addedResults || addedResults.length === 0) return;

    const globalEntries = addedResults.filter((r) => r.entry?.scope !== 'server');
    const serverEntries = addedResults.filter((r) => r.entry?.scope === 'server');

    // Snapshot enrichment for the bulk preview line: one query for all
    // names in the batch instead of N. When snapshot data is present,
    // each row picks up a class-icon prefix (matches v0.5.67 vocab);
    // names without a snapshot fall back to the bare name + reason.
    const allBulkNames = addedResults.map((r) => r.entry?.name || r.name).filter(Boolean);
    let snapshotMap = new Map();
    if (allBulkNames.length > 0) {
      try {
        const snaps = await RosterSnapshot.find({ name: { $in: allBulkNames } })
          .collation({ locale: 'en', strength: 2 })
          .lean();
        snapshotMap = new Map(snaps.map((s) => [s.name.toLowerCase(), s]));
      } catch (err) {
        console.warn('[list] Snapshot lookup for bulk broadcast failed (non-fatal):', err.message);
      }
    }

    const renderBulkLine = (i, t, r) => {
      const name = r.entry?.name || r.name;
      const snap = snapshotMap.get(String(name).toLowerCase());
      const cls = snap?.classId ? getClassName(snap.classId) : '';
      const classPrefix = cls ? `${getClassEmoji(cls) || cls} ` : '';
      const reasonShort = (r.entry?.reason || '').length > 60
        ? (r.entry?.reason || '').slice(0, 57) + '...'
        : (r.entry?.reason || '');
      return `${i + 1}. ${listTypeIcon(t)} ${classPrefix}**${name}** · ${reasonShort}`;
    };

    const buildBulkEmbed = (entries, isLocal) => {
      const grouped = { black: [], white: [], watch: [] };
      for (const r of entries) {
        const t = r.type || r.entry?.type || 'black';
        if (grouped[t]) grouped[t].push(r);
      }

      const embed = new EmbedBuilder()
        .setTitle(`📢 Bulk Add${isLocal ? ' (Local)' : ''} · ${entries.length} entries`)
        .setColor(COLORS.info)
        .setTimestamp(new Date());

      const typeLabels = { black: 'Blacklist', white: 'Whitelist', watch: 'Watchlist' };
      for (const t of ['black', 'white', 'watch']) {
        if (grouped[t].length === 0) continue;
        const lines = grouped[t]
          .slice(0, 15)
          .map((r, i) => renderBulkLine(i, t, r))
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

  return {
    broadcastListChange,
    resolveBroadcastChannels,
    broadcastBulkAdd,
  };
}
