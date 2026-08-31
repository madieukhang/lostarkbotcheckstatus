/**
 * Check-specific detail card shown after selecting a listed name from a
 * /la-check or auto-check result. It borrows the broadcast metadata grid, but
 * uses copy that describes a lookup result instead of announcing a new entry.
 */

import { getClassEmoji, getClassName } from '../../../models/Class.js';
import { t } from '../../../services/i18n/index.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';
import { getAddedByDisplay } from '../../../utils/names.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import { BLANK_FIELD_VALUE, ICONS, padInlineRow, relativeTime } from '../../../utils/ui.js';
import { getListContext } from '../helpers.js';
import { renderTrackedAltsField, resolveRosterWorld } from '../trackedAltsRender.js';

function normalizeNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parsePositiveNumber(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getSnapshotClassName(snapshot) {
  if (!snapshot) return '';
  return snapshot.className || (snapshot.classId ? getClassName(snapshot.classId) : '');
}

function formatLinkedCheckName(entry, snapshot) {
  const className = getSnapshotClassName(snapshot);
  const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';
  return `${classPrefix}**[${entry.name}](${rosterUrl(entry.name)})**`;
}

function buildCheckMetadataFields(entry, snapshot, { includeAddedBy, lang, statMap }) {
  const notAvailable = t('dialogue.broadcast.notAvailable', lang);
  const itemLevel = parsePositiveNumber(snapshot?.itemLevel);
  const combatScore = String(snapshot?.combatScore || '').trim();
  // Read the server across the roster, not just off this one snapshot ·
  // most entries predate the field and the search-only enrichment route
  // never reports one, so the entry's own row is usually blank while a
  // sibling somebody ran /la-roster on knows the answer.
  const world = resolveRosterWorld(entry, statMap);
  const inlineFields = [
    {
      name: `🗡️ ${t('dialogue.broadcast.fields.raid', lang)}`,
      value: entry.raid ? `\`${entry.raid}\`` : notAvailable,
      inline: true,
    },
    {
      name: `🕐 ${t('dialogue.broadcast.fields.added', lang)}`,
      value: entry.addedAt ? relativeTime(entry.addedAt) : notAvailable,
      inline: true,
    },
    {
      name: `📊 ${t('dialogue.broadcast.fields.itemLevel', lang)}`,
      value: itemLevel > 0 ? `\`${itemLevel.toFixed(2)}\`` : notAvailable,
      inline: true,
    },
    {
      name: `⚔️ ${t('dialogue.broadcast.fields.combatPower', lang)}`,
      value: combatScore && combatScore !== '?' ? `\`${combatScore}\`` : notAvailable,
      inline: true,
    },
    includeAddedBy
      ? {
          // listView.evidence.* carries its icon inside the string.
          name: t('listView.evidence.addedBy', lang),
          value: getAddedByDisplay(entry) || notAvailable,
          inline: true,
        }
      : null,
    {
      name: `🌍 ${t('dialogue.roster.server', lang)}`,
      value: world ? `\`${world}\`` : notAvailable,
      inline: true,
    },
  ].filter(Boolean);

  return [
    {
      name: `📝 ${t('dialogue.broadcast.fields.reason', lang)}`,
      value: (entry.reason || notAvailable).slice(0, 1024),
      inline: false,
    },
    // Added by is optional, so the inline count is 5 or 6 depending on
    // the caller · padding by count keeps both cases on whole rows
    // instead of leaving a stretched banner at the end.
    ...padInlineRow(inlineFields),
  ];
}

function buildTrackedAltsField(entry, statMap, lang) {
  // The whole roster, entry included · this card sits next to the same
  // list on the evidence and broadcast cards, and leaving the entry out
  // made it one name shorter than both of them.
  return renderTrackedAltsField({
    names: entry.allCharacters,
    primaryName: entry.name,
    statMap,
    includePrimary: true,
    label: `🧬 ${t('dialogue.broadcast.fields.trackedRosters', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
}

function applyCheckEvidence(embed, entry, displayUrl, lang) {
  if (displayUrl) {
    // An embedded image has no caption of its own, so it butted straight
    // up against whichever field came last. A heading field gives it the
    // same footing as the roster list above it. Cards that put evidence
    // behind a button need none of this · there is no image to caption.
    embed.addFields({
      name: t('listView.evidence.attached', lang),
      value: BLANK_FIELD_VALUE,
      inline: false,
    });
    embed.setImage(displayUrl);
    return;
  }
  if (!entry.imageMessageId && !entry.imageUrl) return;
  embed.addFields({
    name: `${ICONS.warn} ${t('listView.evidence.evidence', lang)}`,
    value: t('listView.evidence.unavailable', lang),
    inline: false,
  });
}

/**
 * Build the detail embed opened by the check-result dropdown.
 *
 * Field order is intentional: Raid / Added / ilvl fill the first inline row;
 * CP / Added by fill the next row, matching the list-change broadcast card.
 * Evidence remains the embed image at the bottom instead of becoming another
 * component interaction.
 */
export function buildCheckEntryDetailsEmbed(entry, {
  displayUrl = '',
  includeAddedBy = false,
  lang = 'en',
  statMap = new Map(),
} = {}) {
  const listType = entry?._listType || 'black';
  const { color, icon } = getListContext(listType);
  const listLabel = t(`dialogue.broadcast.list.${listType}`, lang);
  const scopeTag = entry?.scope === 'server'
    ? ` \`[${t('dialogue.broadcast.localTag', lang)}]\``
    : '';
  const snapshot = statMap.get(normalizeNameKey(entry?.name)) || null;
  const fields = [
    ...buildCheckMetadataFields(entry, snapshot, { includeAddedBy, lang, statMap }),
    buildTrackedAltsField(entry, statMap, lang),
  ].filter(Boolean);

  const embed = createArtistEmbed(lang)
    .setTitle(`🔎 ${t('dialogue.check.details.title', lang, { list: listLabel })}`)
    .setDescription(t('dialogue.check.details.headline', lang, {
      icon,
      name: formatLinkedCheckName(entry, snapshot),
      list: listLabel,
      scope: scopeTag,
    }))
    .addFields(fields)
    .setColor(color)
    .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : new Date());

  applyCheckEvidence(embed, entry, displayUrl, lang);

  return embed;
}
