import { EmbedBuilder } from 'discord.js';

import config from '../../../config.js';
import GuildConfig from '../../../models/GuildConfig.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { getListContext } from '../helpers.js';

export function createBroadcastServices({ client }) {
  async function broadcastListChange(action, entry, payload, options = {}) {
    const { onlyOwner = false, displayUrl: preResolvedUrl } = options;
    const { label, color, icon } = getListContext(payload.type);
    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;

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

    const typeIcon = (t) => (t === 'black' ? '⛔' : t === 'white' ? '✅' : '⚠️');

    const buildBulkEmbed = (entries, isLocal) => {
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
          .slice(0, 15)
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
