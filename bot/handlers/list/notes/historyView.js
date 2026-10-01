/**
 * handlers/list/notes/historyView.js
 * The note history card: one field per note, oldest first, the original
 * marked 🌱, each with its writer. Long histories page by note count and by
 * the embed's text budget.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { t } from '../../../services/i18n/index.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';
import { truncateInlineText } from '../../../utils/discordText.js';
import { formatListScopeTag } from '../entryCardFields.js';
import { getListContext } from '../helpers.js';
import { NOTE_PAGE_PREFIX, formatNoteDate, readEntryNotes } from './entryNotes.js';

const NOTES_PER_PAGE = 10;
// Discord caps an embed at 6000 characters; the title, description and
// footer use the rest.
const PAGE_TEXT_BUDGET = 5500;
// Leaves room for the writer line under the reason in a 1024-character field.
const NOTE_REASON_LIMIT = 950;

function noteField(note, index, total, lang) {
  const tail = [
    index === 0 ? t('dialogue.notes.history.original', lang) : '',
    index === total - 1 && total > 1 ? t('dialogue.notes.history.latest', lang) : '',
    note.byName ? t('dialogue.notes.history.by', lang, { name: note.byName }) : '',
  ].filter(Boolean).join(' · ');
  const reason = truncateInlineText(note.reason, NOTE_REASON_LIMIT) || t('dialogue.broadcast.notAvailable', lang);
  return {
    name: [`${index === 0 ? '🌱' : '📝'} ${formatNoteDate(note.at, lang)}`, note.raid].filter(Boolean).join(' · '),
    value: tail ? `${reason}\n-# ${tail}` : reason,
    inline: false,
  };
}

function packPages(fields) {
  const pages = [[]];
  let used = 0;
  for (const field of fields) {
    const size = field.name.length + field.value.length;
    const page = pages.at(-1);
    const full = page.length === NOTES_PER_PAGE || (page.length > 0 && used + size > PAGE_TEXT_BUDGET);
    if (full) {
      pages.push([field]);
      used = size;
    } else {
      page.push(field);
      used += size;
    }
  }
  return pages;
}

function pageButton(type, entry, target, emoji, labelKey, disabled, lang) {
  return new ButtonBuilder()
    .setCustomId(`${NOTE_PAGE_PREFIX}:${type}:${entry._id}:${target}`)
    .setLabel(t(labelKey, lang))
    .setEmoji(emoji)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);
}

/**
 * @param {object} options
 * @param {object} options.entry - list entry with `_id`
 * @param {string} options.type - black | white | watch
 * @param {number} options.page - 1-based; clamped to the pages that exist
 * @param {string} options.lang - reader language
 * @returns {{embeds: object[], components: object[]}} the history card
 */
export function buildNoteHistoryPayload({ entry, type, page, lang }) {
  const notes = readEntryNotes(entry);
  const pages = packPages(notes.map((note, index) => noteField(note, index, notes.length, lang)));
  const current = Math.min(Math.max(page, 1), pages.length);
  const { color, icon } = getListContext(type);
  const embed = createArtistEmbed()
    .setColor(color)
    .setTitle(`📜 ${t('dialogue.notes.history.title', lang, { name: entry.name })}`)
    .setDescription(t('dialogue.notes.history.head', lang, {
      icon,
      list: t(`dialogue.broadcast.list.${type}`, lang),
      scope: formatListScopeTag(type, entry.scope, lang),
      count: notes.length,
    }))
    .addFields(pages[current - 1])
    .setFooter({
      text: pages.length > 1
        ? t('dialogue.notes.history.footer', lang, { page: current, pages: pages.length })
        : t('dialogue.notes.history.footerSingle', lang),
    });
  const components = pages.length > 1
    ? [new ActionRowBuilder().addComponents(
        pageButton(type, entry, current - 1, '◀️', 'common.pagination.previous', current === 1, lang),
        pageButton(type, entry, current + 1, '▶️', 'common.pagination.next', current === pages.length, lang),
      )]
    : [];
  return { embeds: [embed], components };
}
