/**
 * handlers/list/notes/addedCard.js
 * The card a duplicate add turns into once its report is saved as a note.
 */

import { ActionRowBuilder } from 'discord.js';
import { t } from '../../../services/i18n/index.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { normalizeNameKey } from '../../../utils/names.js';
import { padInlineRow, relativeTime } from '../../../utils/ui.js';
import { buildListEntryReasonField, buildListEntryRostersField, formatListScopeTag } from '../entryCardFields.js';
import { buildBroadcastEvidenceButton } from '../evidence/broadcastButton.js';
import { getListContext } from '../helpers.js';
import { formatLinkedCharacter } from '../trackedAltsRender.js';
import { buildNoteCountLine, buildNoteHistoryButton, readEntryNotes } from './entryNotes.js';

/**
 * @param {object} options
 * @param {object} options.entry - the entry as saved
 * @param {string} options.type - black | white | watch
 * @param {string[]} options.addedAlts - roster names the note added, marked 🆕
 * @param {Map<string, object>} options.statMap - roster snapshots by name key
 * @param {string} options.lang - reader language
 * @returns {{content: null, embeds: object[], components: object[]}}
 */
export function buildNoteAddedPayload({ entry, type, addedAlts, statMap, lang }) {
  const { color, icon } = getListContext(type);
  const list = t(`dialogue.broadcast.list.${type}`, lang);
  const note = readEntryNotes(entry).at(-1);
  const embed = buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: icon,
    color,
    title: t('dialogue.notes.added.title', lang, { list, name: entry.name }),
    description: t('dialogue.notes.added.hero', lang, {
      name: formatLinkedCharacter(entry.name, statMap.get(normalizeNameKey(entry.name))),
      list,
      scope: formatListScopeTag(type, entry.scope, lang),
    }),
    fields: [
      buildListEntryReasonField({ reason: note.reason, noteLine: buildNoteCountLine(entry, lang), lang }),
      ...padInlineRow([
        note.raid ? { name: `🗡️ ${t('dialogue.broadcast.fields.raid', lang)}`, value: `\`${note.raid}\``, inline: true } : null,
        { name: `🕐 ${t('dialogue.notes.added.noted', lang)}`, value: relativeTime(note.at), inline: true },
        { name: `👤 ${t('dialogue.notes.added.notedBy', lang)}`, value: note.byName || t('dialogue.broadcast.notAvailable', lang), inline: true },
      ].filter(Boolean)),
      buildListEntryRostersField({ names: entry.allCharacters, primaryName: entry.name, statMap, lang, newNames: addedAlts }),
    ].filter(Boolean),
    footer: addedAlts.length > 0
      ? t('dialogue.notes.added.footer', lang, {
        count: addedAlts.length,
        altWord: t(`dialogue.broadcast.${addedAlts.length === 1 ? 'altOne' : 'altMany'}`, lang),
      })
      : t('dialogue.notes.added.footerNoAlts', lang),
    lang,
  });
  const buttons = [buildNoteHistoryButton(type, entry, lang), buildBroadcastEvidenceButton(entry, { type, lang })].filter(Boolean);
  return {
    content: null,
    embeds: [embed],
    components: buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons)] : [],
  };
}
