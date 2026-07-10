/**
 * handlers/list/view/ui.js
 * Pure render helpers for /la-list view + the evidence card used by
 * /la-list view, /la-search, /la-evidence, /la-roster, and the
 * approval-flow evidence button. Centralising the embed shape here
 * is what makes those five surfaces stay visually consistent.
 *
 * Exports: buildTrustedListEmbed, buildListPageEmbed,
 * buildListViewComponents, buildEvidenceEmbed, buildExpiredComponents.
 * Per-helper JSDoc is light here · most are pure embed builders with
 * obvious inputs · the buildEvidenceEmbed signature is the only one
 * worth a fuller block (see its declaration).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} from 'discord.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';

import {
  refreshImageUrl,
} from '../../../utils/imageRehost.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import { COLORS, ICONS, relativeTime } from '../../../utils/ui.js';
import { t } from '../../../services/i18n/index.js';
import { renderTrackedAltsField } from '../trackedAltsRender.js';

/**
 * Render the meta line that sits under each entry's name. Uses middot
 * separators to match the rest of the embed family. Falsy fields are
 * dropped silently so entries without a raid / image don't show empty
 * separators.
 */
function capitalizeLabel(value) {
  const text = String(value || '');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function getListTypeLabel(type, fallback, lang) {
  if (type === 'all') return t('listView.labels.allLists', lang);
  if (!type) return capitalizeLabel(fallback);
  const translated = t(`listView.labels.${type}`, lang);
  return translated === `listView.labels.${type}` ? capitalizeLabel(fallback) : translated;
}

function buildEntryMetaLine({ entry, freshUrl, lang = 'en' }) {
  const parts = [];
  if (entry.reason) parts.push(entry.reason.length > 80 ? entry.reason.slice(0, 77) + '...' : entry.reason);
  if (entry.raid) parts.push(`\`${entry.raid}\``);
  if (entry.addedAt) parts.push(relativeTime(entry.addedAt));
  if (freshUrl) parts.push(`[${ICONS.evidence} ${t('listView.meta.evidence', lang)}](${freshUrl})`);
  return parts.length > 0 ? `└ ${parts.join(' · ')}` : '';
}

/**
 * Render the roster (allCharacters) line that sits below the meta
 * line. Goal: tell the reader "who else is on this account" at a
 * glance without blowing up the description budget. The entry's own
 * name is always present in allCharacters and is filtered out (we
 * already showed it on line 1). Capped at 3 visible alts with a
 * `+N more` suffix; entries with no alts skip this line entirely.
 *
 * Why compact: /la-list view renders 10 entries per page and Discord's
 * description hard cap is 4096 chars. Showing every alt inline would
 * blow that budget on guilds with deep rosters; the detail view + DM
 * surface the full list when an officer wants the whole picture.
 */
function buildEntryRosterLine(entry, lang = 'en') {
  const others = (entry.allCharacters || [])
    .filter((n) => String(n).toLowerCase() !== String(entry.name).toLowerCase());
  if (others.length === 0) return '';
  const visible = others.slice(0, 3);
  const linked = visible.map((n) => `[${n}](${rosterUrl(n)})`);
  const tail = others.length > visible.length
    ? ` *${t('listView.meta.more', lang, { count: others.length - visible.length })}*`
    : '';
  return `   ↳ ${t('listView.meta.alts', lang)}: ${linked.join(', ')}${tail}`;
}

function getEvidenceCacheKey(entry) {
  if (!entry.imageMessageId || !entry.imageChannelId) return '';
  return `${entry.imageChannelId}:${entry.imageMessageId}`;
}

export function buildTrustedListEmbed(entries, lang = 'en') {
  const lines = entries.flatMap((entry) => {
    const link = rosterUrl(entry.name);
    const head = `${ICONS.shield} **[${entry.name}](${link})**`;
    const meta = buildEntryMetaLine({ entry, freshUrl: '', lang });
    const rosterLine = buildEntryRosterLine(entry, lang);
    const block = [head];
    if (meta) block.push(meta);
    if (rosterLine) block.push(rosterLine);
    block.push('');
    return block;
  });
  // Drop trailing blank line for cleaner footer-adjacent rendering.
  if (lines[lines.length - 1] === '') lines.pop();

  // Count rides the title (matches the list-page card); the footer keeps
  // the "what trusted means" reminder + the manage hint.
  return createArtistEmbed()
    .setTitle(`${ICONS.shield} ${t('listView.trusted.title', lang)} · ${entries.length}`)
    .setDescription(lines.join('\n').slice(0, 4096))
    .setColor(COLORS.trustedSoft)
    .setFooter({
      text: t('listView.trusted.footer', lang),
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
    lang = 'en',
    page,
    evidenceUrlCache,
    refreshImageUrlFn = refreshImageUrl,
    totalPages,
  } = options;
  const start = page * itemsPerPage;
  const pageEntries = allEntries.slice(start, start + itemsPerPage);
  const freshUrls = await Promise.all(
    pageEntries.map(async (entry) => {
      if (entry.imageMessageId && entry.imageChannelId) {
        const cacheKey = getEvidenceCacheKey(entry);
        if (evidenceUrlCache?.has(cacheKey)) {
          return evidenceUrlCache.get(cacheKey) || '';
        }
        const fresh = await refreshImageUrlFn(entry.imageMessageId, entry.imageChannelId, client);
        if (fresh) evidenceUrlCache?.set(cacheKey, fresh);
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
        scopeTag = ` \`[${t('listView.scope.localWithGuild', lang, { guildName })}]\``;
      } else {
        scopeTag = ` \`[${t('listView.scope.local', lang)}]\``;
      }
    }
    const link = rosterUrl(entry.name);
    const head = `\`${String(start + index + 1).padStart(2, ' ')}\` ${entry._icon} **[${entry.name}](${link})**${scopeTag}`;
    const meta = buildEntryMetaLine({ entry, freshUrl: freshUrls[index], lang });
    const rosterLine = buildEntryRosterLine(entry, lang);
    lines.push(head);
    if (meta) lines.push(meta);
    if (rosterLine) lines.push(rosterLine);
    lines.push('');
  });
  if (lines[lines.length - 1] === '') lines.pop();

  const ctx = currentType === 'all' ? null : getListContext(currentType);
  const labelCap = getListTypeLabel(currentType, ctx?.label, lang);
  const titleIcon = ctx?.icon || ICONS.search;

  // Total count lives in the title (same `Subject · count` shape as the
  // /la-list add result card), so the description header only carries
  // page context. Empty line below separates it from the entry block.
  const headerLine = t('listView.summary.header', lang, {
    page: page + 1,
    totalPages,
    shown: pageEntries.length,
  });
  const description = [headerLine, '', ...lines].join('\n').slice(0, 4096);

  return createArtistEmbed()
    .setTitle(`${titleIcon} ${labelCap} · ${allEntries.length} ${t('listView.summary.entries', lang)}`)
    .setDescription(description)
    .setColor(currentType === 'all' ? COLORS.info : ctx.color)
    .setFooter({
      text: `${ICONS.refresh} ${t('listView.summary.footer', lang)}`,
    })
    .setTimestamp();
}

export function buildListViewComponents({ allEntries, itemsPerPage, lang = 'en', page, totalPages }) {
  const rows = [];
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('listview_prev')
        .setLabel(t('common.pagination.previous', lang))
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
        .setLabel(t('common.pagination.next', lang))
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
          .setPlaceholder(`${ICONS.evidence} ${t('listView.navigation.evidencePlaceholder', lang)}`)
          .addOptions(
            withImages.slice(0, 25).map((entry) => ({
              label: entry.name,
              description: (entry.reason || t('listView.navigation.noReason', lang)).slice(0, 100),
              value: String(start + pageEntries.indexOf(entry)),
              emoji: entry._icon,
            }))
          )
      )
    );
  }

  return rows;
}

/**
 * Detail view for a single list entry, used when an officer clicks
 * the evidence dropdown in /la-list view (and now also as the shared
 * renderer for /la-search evidence clicks). Layout has 3 visual blocks:
 *
 *   1. Title bar    - list-icon + entry name + bible-link via setURL
 *   2. Reason field - full reason text (1024 char cap)
 *   3. Inline meta  - Raid · List · Added (3-up grid)
 *   4. Roster field - "Tracked alts" with linked names; falls back
 *                     to "(only this character)" if allCharacters is
 *                     just the entry name
 *   5. Evidence     - image OR warning placeholder when expired
 *   6. Logs / Added by (optional) - kept from prior version
 *
 * The Roster field is the headline change vs the older detail card:
 * an officer auditing a blacklist hit can now see the full list of
 * names that resolve to this entry without re-running /la-list view
 * or hitting bible directly.
 */
export function buildEvidenceEmbed(entry, displayUrl, { includeAddedBy = false, lang = 'en' } = {}) {
  const link = rosterUrl(entry.name);
  const fields = [
    { name: t('listView.evidence.reason', lang), value: (entry.reason || 'N/A').slice(0, 1024), inline: false },
  ];

  const inlineMeta = [];
  if (entry.raid) inlineMeta.push({ name: t('listView.evidence.raid', lang), value: `\`${entry.raid}\``, inline: true });
  inlineMeta.push({
    name: t('listView.evidence.list', lang),
    value: getListTypeLabel(entry._listType, entry._label, lang),
    inline: true,
  });
  if (entry.addedAt) {
    inlineMeta.push({ name: t('listView.evidence.added', lang), value: relativeTime(entry.addedAt), inline: true });
  }
  fields.push(...inlineMeta);

  // Roster (allCharacters) field. Counts alts excluding the entry's own
  // name, then renders a numbered list with bible roster links so the
  // officer can click straight through to verify any alt. Capped at 12
  // visible names with `+N more` overflow line so the field stays
  // under Discord's 1024-char field-value limit.
  // Tracked alts via the shared renderer. View detail always shows the
  // field (sentinel when empty) because it's part of the layout grammar
  // the officer expects · the field is removed only when there is no
  // entry at all, not when an entry happens to have no alts.
  const altsField = renderTrackedAltsField({
    names: entry.allCharacters,
    primaryName: entry.name,
    emptySentinel: t('listView.evidence.onlyThisCharacter', lang),
    label: `🧬 ${t('dialogue.broadcast.fields.trackedAlts', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
  if (altsField) fields.push(altsField);

  const embed = createArtistEmbed(lang)
    .setTitle(`${entry._icon} ${entry.name}`)
    .setURL(link)
    .addFields(fields)
    .setColor(entry._color)
    .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

  if (displayUrl) {
    embed.setImage(displayUrl);
  } else {
    embed.addFields({
      name: `${ICONS.warn} ${t('listView.evidence.evidence', lang)}`,
      value: t('listView.evidence.unavailable', lang),
      inline: false,
    });
  }

  if (entry.logsUrl) {
    embed.addFields({
      name: t('listView.evidence.logs', lang),
      value: `[${t('listView.evidence.viewLogs', lang)}](${entry.logsUrl})`,
      inline: false,
    });
  }

  if (includeAddedBy && entry.addedByDisplayName) {
    embed.addFields({ name: t('listView.evidence.addedBy', lang), value: entry.addedByDisplayName, inline: true });
  }

  return embed;
}

export function buildExpiredComponents(lang = 'en') {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('listview_prev_disabled')
        .setLabel(t('common.pagination.previous', lang))
        .setEmoji(ICONS.prev)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('listview_expired')
        .setLabel(t('listView.navigation.expired', lang))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId('listview_next_disabled')
        .setLabel(t('common.pagination.next', lang))
        .setEmoji(ICONS.next)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true)
    ),
  ];
}
