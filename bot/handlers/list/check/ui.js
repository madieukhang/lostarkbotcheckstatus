/**
 * Broadcast-style detail card shown after selecting a listed name from a
 * /la-check or auto-check result. The check summary stays compact; this card
 * carries the richer context without changing /la-evidence or /la-list view.
 */

import { getClassEmoji, getClassName } from '../../../models/Class.js';
import { t } from '../../../services/i18n/index.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';
import { getAddedByDisplay } from '../../../utils/names.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import { ICONS, relativeTime } from '../../../utils/ui.js';
import { getListContext } from '../helpers.js';
import { renderTrackedAltsField } from '../trackedAltsRender.js';

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
  const className = getSnapshotClassName(snapshot);
  const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';
  const linkedName = `${classPrefix}**[${entry.name}](${rosterUrl(entry.name)})**`;
  const notAvailable = t('dialogue.broadcast.notAvailable', lang);
  const itemLevel = parsePositiveNumber(snapshot?.itemLevel);
  const combatScore = String(snapshot?.combatScore || '').trim();

  const fields = [
    {
      name: `📝 ${t('dialogue.broadcast.fields.reason', lang)}`,
      value: (entry.reason || notAvailable).slice(0, 1024),
      inline: false,
    },
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
      value: combatScore && combatScore !== '?' ? combatScore : notAvailable,
      inline: true,
    },
  ];

  if (includeAddedBy) {
    fields.push({
      name: t('listView.evidence.addedBy', lang),
      value: getAddedByDisplay(entry) || notAvailable,
      inline: true,
    });
  }

  const altsField = renderTrackedAltsField({
    names: entry.allCharacters,
    primaryName: entry.name,
    statMap,
    label: `🧬 ${t('dialogue.broadcast.fields.trackedAlts', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
  if (altsField) fields.push(altsField);

  const embed = createArtistEmbed(lang)
    .setTitle(`🎨 ${t('dialogue.broadcast.titles.added', lang, { list: listLabel })}`)
    .setDescription(t('dialogue.broadcast.headlines.added', lang, {
      icon,
      name: linkedName,
      list: listLabel,
      scope: scopeTag,
    }))
    .addFields(fields)
    .setColor(color)
    .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : new Date());

  if (displayUrl) {
    embed.setImage(displayUrl);
  } else if (entry.imageMessageId || entry.imageUrl) {
    embed.addFields({
      name: `${ICONS.warn} ${t('listView.evidence.evidence', lang)}`,
      value: t('listView.evidence.unavailable', lang),
      inline: false,
    });
  }

  return embed;
}
