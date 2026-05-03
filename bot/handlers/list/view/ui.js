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
import { COLORS, ICONS, relativeTime } from '../../../utils/ui.js';

/**
 * Build a single roster-link Markdown for an entry name.
 */
function rosterLink(name) {
  return `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
}

/**
 * Render the meta line that sits under each entry's name. Uses middot
 * separators to match the rest of the embed family. Falsy fields are
 * dropped silently so entries without a raid / image don't show empty
 * separators.
 */
function buildEntryMetaLine({ entry, freshUrl }) {
  const parts = [];
  if (entry.reason) parts.push(entry.reason.length > 80 ? entry.reason.slice(0, 77) + '...' : entry.reason);
  if (entry.raid) parts.push(`\`${entry.raid}\``);
  if (entry.addedAt) parts.push(relativeTime(entry.addedAt));
  if (freshUrl) parts.push(`[${ICONS.evidence} evidence](${freshUrl})`);
  return parts.length > 0 ? `└ ${parts.join(' · ')}` : '';
}

export function buildTrustedListEmbed(entries) {
  const lines = entries.flatMap((entry) => {
    const link = rosterLink(entry.name);
    const head = `${ICONS.shield} **[${entry.name}](${link})**`;
    const meta = buildEntryMetaLine({ entry, freshUrl: '' });
    return meta ? [head, meta, ''] : [head, ''];
  });
  // Drop trailing blank line for cleaner footer-adjacent rendering.
  if (lines[lines.length - 1] === '') lines.pop();

  return new EmbedBuilder()
    .setTitle(`${ICONS.shield} Trusted Users`)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setColor(COLORS.trustedSoft)
    .setFooter({
      text: `${entries.length} trusted character${entries.length === 1 ? '' : 's'} · cannot be added to any list`,
    })
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

  // Two-line entry layout. Line 1 is name + list-type icon + scope tag;
  // line 2 (prefixed `└ `) carries reason / raid / time / evidence link.
  // Empty line between entries gives breathing room. Description has a
  // 4096-char hard cap from Discord; truncate at the entry boundary if
  // we go over (10 entries * ~200 chars each is well under, but be safe).
  const lines = [];
  pageEntries.forEach((entry, index) => {
    let scopeTag = '';
    if (entry.scope === 'server') {
      if (isOwnerGuild && entry.guildId) {
        const guildName = guildNameCache.get(entry.guildId) || entry.guildId;
        scopeTag = ` \`[Local: ${guildName}]\``;
      } else {
        scopeTag = ' `[Local]`';
      }
    }
    const link = rosterLink(entry.name);
    const head = `\`${String(start + index + 1).padStart(2, ' ')}\` ${entry._icon} **[${entry.name}](${link})**${scopeTag}`;
    const meta = buildEntryMetaLine({ entry, freshUrl: freshUrls[index] });
    lines.push(head);
    if (meta) lines.push(meta);
    lines.push('');
  });
  if (lines[lines.length - 1] === '') lines.pop();

  const ctx = currentType === 'all' ? null : getListContext(currentType);
  const labelCap = ctx
    ? ctx.label.charAt(0).toUpperCase() + ctx.label.slice(1)
    : 'All Lists';
  const titleIcon = ctx?.icon || ICONS.search;

  // Showing-N-of-M header line at the top of the description gives
  // immediate context (filter scope, count, page) without having to
  // scan the footer. Empty line below to separate from the entry block.
  const headerLine = `Showing **${pageEntries.length}** of **${allEntries.length}** ${ctx ? ctx.label + ' entries' : 'entries'} · page **${page + 1}** / ${totalPages}`;
  const description = [headerLine, '', ...lines].join('\n').slice(0, 4096);

  return new EmbedBuilder()
    .setTitle(`${titleIcon} ${labelCap}`)
    .setDescription(description)
    .setColor(currentType === 'all' ? COLORS.info : ctx.color)
    .setFooter({
      text: `${ICONS.refresh} Refresh with /la-list view · navigate with the buttons below`,
    })
    .setTimestamp();
}

export function buildListViewComponents({ allEntries, itemsPerPage, page, totalPages }) {
  const rows = [];
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('listview_prev')
        .setLabel('Previous')
        .setEmoji(ICONS.prev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId('listview_page_indicator')
        .setLabel(`${page + 1} / ${totalPages}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('listview_next')
        .setLabel('Next')
        .setEmoji(ICONS.next)
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
          .setPlaceholder(`${ICONS.evidence} View evidence for...`)
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
  const link = rosterLink(entry.name);
  const fields = [
    { name: 'Reason', value: entry.reason || 'N/A', inline: false },
  ];
  const inlineMeta = [];
  if (entry.raid) inlineMeta.push({ name: 'Raid', value: `\`${entry.raid}\``, inline: true });
  inlineMeta.push({ name: 'List', value: entry._label, inline: true });
  if (entry.addedAt) {
    inlineMeta.push({ name: 'Added', value: relativeTime(entry.addedAt), inline: true });
  }
  fields.push(...inlineMeta);

  const embed = new EmbedBuilder()
    .setTitle(`${entry._icon} ${entry.name}`)
    .setURL(link)
    .addFields(fields)
    .setColor(entry._color)
    .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

  if (displayUrl) {
    embed.setImage(displayUrl);
  } else {
    embed.addFields({
      name: `${ICONS.warn} Evidence`,
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
        .setLabel('Previous')
        .setEmoji(ICONS.prev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('listview_expired')
        .setLabel('Session expired · re-run /la-list view')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('listview_next_disabled')
        .setLabel('Next')
        .setEmoji(ICONS.next)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    ),
  ];
}
