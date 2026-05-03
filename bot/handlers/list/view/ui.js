import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import {
  refreshImageUrl,
} from '../../../utils/imageRehost.js';

export function buildTrustedListEmbed(entries) {
  const lines = entries.map((entry, index) => {
    const parts = [`🛡️ **${entry.name}**`];
    if (entry.reason) parts.push(entry.reason);
    const date = entry.addedAt ? `<t:${Math.floor(new Date(entry.addedAt).getTime() / 1000)}:R>` : '';
    if (date) parts.push(date);
    return `${index + 1}. ${parts.join(' — ')}`;
  });

  return new EmbedBuilder()
    .setTitle(`🛡️ Trusted Users (${entries.length})`)
    .setDescription(lines.join('\n'))
    .setColor(0x57d6a1)
    .setTimestamp();
}

export async function buildListPageEmbed(options) {
  const {
    allEntries,
    client,
    currentType,
    getListContext,
    guildNameCache,
    isOwnerGuild,
    itemsPerPage,
    page,
    totalPages,
  } = options;
  const start = page * itemsPerPage;
  const pageEntries = allEntries.slice(start, start + itemsPerPage);
  const freshUrls = await Promise.all(
    pageEntries.map(async (entry) => {
      if (entry.imageMessageId && entry.imageChannelId) {
        const fresh = await refreshImageUrl(entry.imageMessageId, entry.imageChannelId, client);
        return fresh || '';
      }
      return entry.imageUrl || '';
    })
  );

  const lines = pageEntries.map((entry, index) => {
    let scopeLabel = '';
    if (entry.scope === 'server') {
      if (isOwnerGuild && entry.guildId) {
        const guildName = guildNameCache.get(entry.guildId) || entry.guildId;
        scopeLabel = ` (Local: ${guildName})`;
      } else {
        scopeLabel = ' (Local)';
      }
    }

    const parts = [`${entry._icon} **${entry.name}**${scopeLabel}`];
    if (entry.reason) parts.push(entry.reason);
    if (entry.raid) parts.push(`[${entry.raid}]`);
    const date = entry.addedAt ? `<t:${Math.floor(new Date(entry.addedAt).getTime() / 1000)}:R>` : '';
    if (date) parts.push(date);
    const imgUrl = freshUrls[index];
    if (imgUrl) parts.push(`[📎](${imgUrl})`);
    return `${start + index + 1}. ${parts.join(' — ')}`;
  });

  return new EmbedBuilder()
    .setTitle(
      currentType === 'all'
        ? `All Lists (${allEntries.length})`
        : `${getListContext(currentType).icon} ${getListContext(currentType).label} (${allEntries.length})`
    )
    .setDescription(lines.join('\n'))
    .setColor(currentType === 'all' ? 0x5865f2 : getListContext(currentType).color)
    .setFooter({ text: `Page ${page + 1}/${totalPages}` })
    .setTimestamp();
}

export function buildListViewComponents({ allEntries, itemsPerPage, page, totalPages }) {
  const rows = [];
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('listview_prev')
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('listview_next')
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    )
  );

  const start = page * itemsPerPage;
  const pageEntries = allEntries.slice(start, start + itemsPerPage);
  const withImages = pageEntries.filter((entry) => entry.imageUrl || entry.imageMessageId);

  if (withImages.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('listview_evidence')
          .setPlaceholder('📎 View evidence for...')
          .addOptions(
            withImages.slice(0, 25).map((entry) => ({
              label: entry.name,
              description: (entry.reason || 'No reason').slice(0, 100),
              value: String(start + pageEntries.indexOf(entry)),
              emoji: entry._icon,
            }))
          )
      )
    );
  }

  return rows;
}

export function buildEvidenceEmbed(entry, displayUrl, { includeAddedBy = false } = {}) {
  const embed = new EmbedBuilder()
    .setTitle(`${entry._icon} ${entry.name}`)
    .addFields(
      { name: 'Reason', value: entry.reason || 'N/A', inline: true },
      { name: 'Raid', value: entry.raid || 'N/A', inline: true },
      { name: 'List', value: entry._label, inline: true }
    )
    .setColor(entry._color)
    .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

  if (displayUrl) {
    embed.setImage(displayUrl);
  } else {
    embed.addFields({
      name: '⚠️ Evidence',
      value: 'Image link expired or unavailable. Re-add evidence via `/la-list edit`.',
      inline: false,
    });
  }

  if (entry.logsUrl) {
    embed.addFields({ name: 'Logs', value: `[View Logs](${entry.logsUrl})`, inline: false });
  }

  if (includeAddedBy && entry.addedByDisplayName) {
    embed.addFields({ name: 'Added by', value: entry.addedByDisplayName, inline: true });
  }

  return embed;
}

export function buildExpiredComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('listview_prev_disabled')
        .setLabel('◀ Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('listview_next_disabled')
        .setLabel('Next ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    ),
  ];
}
