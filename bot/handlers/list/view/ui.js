/**
 * handlers/list/view/ui.js
 * Pure render helpers for /la-list view + the evidence card used by
 * /la-list view, /la-search, /la-evidence, /la-roster, and the
 * approval-flow evidence button. Centralising the embed shape here
 * is what makes those five surfaces stay visually consistent.
 *
 * Exports: buildTrustedListEmbed, buildListPageEmbed,
 * buildListViewComponents, buildEvidenceEmbed, buildExpiredComponents.
 * Most helpers are pure embed builders with shared input conventions, so
 * buildEvidenceEmbed is the only function with expanded parameter docs.
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
import { getAddedByDisplay } from '../../../utils/names.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import { COLORS, ICONS, relativeTime } from '../../../utils/ui.js';
import { t } from '../../../services/i18n/index.js';
import { formatLinkedCharacter, renderTrackedAltsField } from '../trackedAltsRender.js';
import { getListContext } from '../helpers.js';

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
 * line. It summarizes the other characters on the account within the
 * description budget. The entry name is always present in allCharacters
 * and is filtered out because line 1 already displays it. Capped at 3 visible alts with a
 * `+N more` suffix; entries with no alts skip this line entirely.
 *
 * Why compact: /la-list view renders 10 entries per page and Discord's
 * description hard cap is 4096 chars. Showing every alt inline can exceed
 * that budget on deep rosters; the detail view and DM expose the full list.
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
  // Drop the trailing blank line before footer-adjacent content.
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
  // Empty lines separate entries. Discord applies a 4096-character
  // description cap, so rendering truncates at an entry boundary.
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

/**
 * Build pagination controls and, when available, an evidence selector for the
 * current list page.
 * @param {object} options
 * @param {Array<object>} options.allEntries - complete filtered list
 * @param {number} options.itemsPerPage - page size used by the matching embed
 * @param {string} [options.lang='en'] - translation locale
 * @param {number} options.page - zero-based page index
 * @param {number} options.totalPages - total page count
 * @returns {ActionRowBuilder[]} Discord component rows
 */
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
        .setDisabled(page >= totalPages - 1),
      new ButtonBuilder()
        .setCustomId('listview_refresh')
        .setLabel(t('listView.navigation.refresh', lang))
        .setEmoji(ICONS.refresh)
        .setStyle(ButtonStyle.Secondary)
    )
  );

  const start = page * itemsPerPage;
  const pageEntries = allEntries.slice(start, start + itemsPerPage);
  // Capture the absolute index during the page pass. Besides avoiding an
  // indexOf rescan per evidence row, this remains correct when entries share
  // object values or the visible page is a slice of a filtered collection.
  const withImages = [];
  for (const [offset, entry] of pageEntries.entries()) {
    if (entry.imageUrl || entry.imageMessageId) {
      withImages.push({ entry, absoluteIndex: start + offset });
    }
  }

  if (withImages.length > 0) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('listview_evidence')
          .setPlaceholder(`${ICONS.evidence} ${t('listView.navigation.evidencePlaceholder', lang)}`)
          .addOptions(
            withImages.slice(0, 25).map(({ entry, absoluteIndex }) => ({
              label: entry.name,
              description: (entry.reason || t('listView.navigation.noReason', lang)).slice(0, 100),
              value: String(absoluteIndex),
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
 *   3. Inline meta  - Raid · List · Added · ilvl · CP · Added by,
 *                     padded with zero-width spacers to whole 3-up rows
 *   4. Roster field - "Tracked alts" with linked names; falls back
 *                     to "(only this character)" if allCharacters is
 *                     just the entry name
 *   5. Evidence     - image, expired warning, or an explicit not-attached note
 *   6. Logs (optional)
 *
 * `statMap` (lowercase name -> `{ className, itemLevel, combatScore }`,
 * built by statMapFromRosterCharacters or a RosterSnapshot query) is what
 * turns the alt rows from bare links into class + ilvl + CP rows and fills
 * the ilvl / CP slots. It is optional: a caller with no roster data in hand
 * gets the card without those slots rather than a grid of "N/A", which is
 * why this reads as an upgrade on /la-roster and a no-op everywhere else
 * until those callers pass one too.
 */
export function buildEvidenceEmbed(entry, displayUrl, {
  includeAddedBy = false,
  lang = 'en',
  statMap = new Map(),
  headline = false,
  attachImage = true,
} = {}) {
  const link = rosterUrl(entry.name);
  const fields = [
    { name: t('listView.evidence.reason', lang), value: (entry.reason || 'N/A').slice(0, 1024), inline: false },
  ];

  const snapshot = statMap.get(String(entry.name || '').trim().toLowerCase()) || null;
  const itemLevel = Number(String(snapshot?.itemLevel ?? '').replace(/,/g, ''));
  const combatScore = String(snapshot?.combatScore || '').trim();
  const addedByDisplay = getAddedByDisplay(entry);

  const inlineMeta = [];
  if (entry.raid) inlineMeta.push({ name: t('listView.evidence.raid', lang), value: `\`${entry.raid}\``, inline: true });
  if (!headline) {
    // With a headline the list is already named in the sentence above.
    inlineMeta.push({
      name: t('listView.evidence.list', lang),
      value: getListTypeLabel(entry._listType, entry._label, lang),
      inline: true,
    });
  }
  if (entry.addedAt) {
    inlineMeta.push({ name: t('listView.evidence.added', lang), value: relativeTime(entry.addedAt), inline: true });
  }
  // ilvl and CP only appear when the caller supplied a stat snapshot.
  // Rendering them as "N/A" would cost two slots on every surface that
  // has no roster data to give, which is most of them.
  if (Number.isFinite(itemLevel) && itemLevel > 0) {
    inlineMeta.push({ name: t('listView.evidence.itemLevel', lang), value: `\`${itemLevel.toFixed(2)}\``, inline: true });
  }
  if (combatScore && combatScore !== '?') {
    inlineMeta.push({ name: t('listView.evidence.combatPower', lang), value: `\`${combatScore}\``, inline: true });
  }
  // Added by joins the grid instead of trailing the card, the way the
  // check-detail embed places it beside CP.
  if (includeAddedBy && addedByDisplay) {
    inlineMeta.push({ name: t('listView.evidence.addedBy', lang), value: addedByDisplay, inline: true });
  }
  // Discord packs three inline fields per row and stretches a lone
  // trailing field to full width · pad to a whole row so the grid keeps
  // its columns whatever combination of optional fields showed up.
  while (inlineMeta.length % 3 !== 0) {
    inlineMeta.push({ name: '\u200b', value: '\u200b', inline: true });
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
    statMap,
    emptySentinel: t('listView.evidence.onlyThisCharacter', lang),
    label: `🧬 ${t('dialogue.broadcast.fields.trackedAlts', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
  if (altsField) fields.push(altsField);

  const embed = createArtistEmbed(lang)
    .addFields(fields)
    .setColor(entry._color)
    .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

  if (headline) {
    // Notice shape, borrowed from the list-change broadcast: a title that
    // names the list, then one Artist line naming the character. The name
    // is linked inside that line, so the title drops its own URL rather
    // than offering the same link twice.
    const listLabel = getListTypeLabel(entry._listType, entry._label, lang);
    const scopeTag = entry.scope === 'server'
      ? ` \`[${t('dialogue.broadcast.localTag', lang)}]\``
      : '';
    embed
      .setTitle(`🔎 ${t('dialogue.check.details.title', lang, { list: listLabel })}`)
      .setDescription(t('dialogue.check.details.headline', lang, {
        icon: getListContext(entry._listType).icon,
        name: formatLinkedCharacter(entry.name, snapshot),
        list: listLabel,
        scope: scopeTag,
      }));
  } else {
    embed.setTitle(`${entry._icon} ${entry.name}`).setURL(link);
  }

  // attachImage:false sends evidence to a button beside the card · a
  // full-width screenshot dwarfs the data when this card is a side note
  // rather than the thing the reader asked for.
  if (attachImage && displayUrl) {
    embed.setImage(displayUrl);
  } else if (attachImage) {
    const evidenceMessage = entry.imageMessageId || entry.imageUrl
      ? t('listView.evidence.unavailable', lang)
      : t('listView.evidence.noImage', lang);
    embed.addFields({
      name: `${ICONS.warn} ${t('listView.evidence.evidence', lang)}`,
      value: evidenceMessage,
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
