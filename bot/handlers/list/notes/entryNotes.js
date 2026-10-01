/**
 * handlers/list/notes/entryNotes.js
 * Reads and writes the note history of a list entry. The entry's own
 * reason and raid always mirror its latest note. An entry saved before
 * notes existed reads as one original note built from its add fields;
 * that note is only written to the database with the first appended one.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { t } from '../../../services/i18n/index.js';
import { FIELD_VALUE_LIMIT } from '../entryCardFields.js';

export const NOTE_HISTORY_PREFIX = 'listnote_history';
export const NOTE_PAGE_PREFIX = 'listnote_page';

// Dates sit in embed field names, where Discord does not render <t:...>
// timestamps, so they are written out in the reader's language. UTC keeps
// one date for one note across readers.
const NOTE_DATE_FORMATS = Object.freeze({
  en: new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }),
  vi: new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }),
  jp: new Intl.DateTimeFormat('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' }),
});

const storedNotes = entry => entry.notes || [];

const plainNote = ({ at, reason, raid, byUserId, byName }) => ({ at, reason, raid, byUserId, byName });

function originalNote(entry) {
  return {
    at: entry.addedAt ?? null,
    reason: entry.reason || '',
    raid: entry.raid || '',
    byUserId: entry.addedByUserId || '',
    byName: entry.addedByDisplayName || entry.addedByTag || entry.addedByName || '',
  };
}

// Pins the note count that was read, so a note saved in between makes the
// write match nothing instead of landing on the wrong position.
function notesSizeFilter(entry) {
  const count = storedNotes(entry).length;
  return count > 0
    ? { notes: { $size: count } }
    : { $or: [{ notes: { $exists: false } }, { notes: { $size: 0 } }] };
}

/**
 * @param {object} entry - list entry, lean or document
 * @returns {Array<{at: Date|null, reason: string, raid: string, byUserId: string, byName: string}>} notes, oldest first
 */
export function readEntryNotes(entry) {
  const notes = storedNotes(entry);
  return notes.length > 0 ? notes.map(plainNote) : [originalNote(entry)];
}

/**
 * @param {object} entry - list entry
 * @returns {number} how many notes the entry reads as, at least 1
 */
export function countEntryNotes(entry) {
  return Math.max(storedNotes(entry).length, 1);
}

/**
 * Build the write that appends one note and mirrors it into reason/raid.
 * @param {object} entry - the entry as read
 * @param {object} note - { at, reason, raid, byUserId, byName }
 * @param {object} [options]
 * @param {string[]} [options.rosterNames=[]] - roster names to merge into allCharacters
 * @param {object} [options.set={}] - further fields to set with the note (evidence, logs)
 * @returns {{filter: object, update: object}} arguments for findOneAndUpdate
 */
export function buildNoteAppend(entry, note, { rosterNames = [], set = {} } = {}) {
  const hasStoredNotes = storedNotes(entry).length > 0;
  const refreshesRoster = rosterNames.length > 0;
  return {
    filter: { _id: entry._id, ...notesSizeFilter(entry) },
    update: {
      $set: {
        ...set,
        reason: note.reason,
        raid: note.raid,
        ...(hasStoredNotes ? {} : { notes: [originalNote(entry), note] }),
        ...(refreshesRoster ? { enrichmentSource: 'bible', enrichedAt: note.at } : {}),
      },
      ...(hasStoredNotes ? { $push: { notes: note } } : {}),
      ...(refreshesRoster ? { $addToSet: { allCharacters: { $each: rosterNames } } } : {}),
    },
  };
}

/**
 * Plan an edit's write to the latest note so reason and raid keep
 * mirroring it. The filter pins the note count whenever reason or raid
 * change; an entry without stored notes gets no notes written.
 * @param {object} entry - the entry as read
 * @param {{reason?: string, raid?: string}} changes - new values; empty ones are left alone
 * @returns {{filter: object, set: object}} extra filter keys and $set keys
 */
export function planLatestNoteEdit(entry, { reason, raid }) {
  const edited = Object.entries({ reason, raid }).filter(([, value]) => value);
  if (edited.length === 0) return { filter: {}, set: {} };
  const last = storedNotes(entry).length - 1;
  return {
    filter: notesSizeFilter(entry),
    set: last < 0 ? {} : Object.fromEntries(edited.map(([key, value]) => [`notes.${last}.${key}`, value])),
  };
}

/**
 * The notes an entry carries into another list, with an edit's new reason
 * and raid applied to the latest one.
 * @param {object} entry - the source entry
 * @param {{reason?: string, raid?: string}} changes - new values; empty ones are left alone
 * @returns {object[]} plain notes; empty for an entry without stored notes
 */
export function carryNotesWithEdit(entry, { reason, raid }) {
  const notes = storedNotes(entry).map(plainNote);
  const latest = notes.at(-1);
  if (latest) Object.assign(latest, reason ? { reason } : {}, raid ? { raid } : {});
  return notes;
}

/**
 * @param {Date|string|null} date - when the note was written
 * @param {string} lang - reader language
 * @returns {string} the date as text, or the N/A label without a date
 */
export function formatNoteDate(date, lang) {
  return date ? NOTE_DATE_FORMATS[lang].format(new Date(date)) : t('dialogue.broadcast.notAvailable', lang);
}

/**
 * @param {object} entry - list entry
 * @param {string} lang - reader language
 * @returns {string|null} the `-# 📜 N notes · first on <date>` line, or null below two notes
 */
export function buildNoteCountLine(entry, lang) {
  const notes = readEntryNotes(entry);
  if (notes.length < 2) return null;
  return `-# 📜 ${t('dialogue.notes.countLine', lang, { count: notes.length, date: formatNoteDate(notes[0].at, lang) })}`;
}

/**
 * Append the count line to a field value, cutting the value so both fit.
 * @param {string} value - the field value
 * @param {string|null} noteLine - from buildNoteCountLine
 * @returns {string}
 */
export function withNoteCountLine(value, noteLine) {
  if (!noteLine) return value;
  return `${value.slice(0, FIELD_VALUE_LIMIT - noteLine.length - 1)}\n${noteLine}`;
}

/**
 * @param {string} type - black | white | watch
 * @param {object} entry - list entry with `_id`
 * @param {string} lang - label language
 * @returns {ButtonBuilder|null} the History button, or null below two notes
 */
export function buildNoteHistoryButton(type, entry, lang) {
  const count = countEntryNotes(entry);
  if (count < 2) return null;
  return new ButtonBuilder()
    .setCustomId(`${NOTE_HISTORY_PREFIX}:${type}:${entry._id}:1`)
    .setLabel(t('common.actions.noteHistory', lang, { count }))
    .setEmoji('📜')
    .setStyle(ButtonStyle.Secondary);
}

/**
 * @param {string} type - black | white | watch
 * @param {object} entry - list entry with `_id`
 * @param {string} lang - label language
 * @returns {ActionRowBuilder[]} one row with the History button, or none
 */
export function buildNoteHistoryRows(type, entry, lang) {
  const button = buildNoteHistoryButton(type, entry, lang);
  return button ? [new ActionRowBuilder().addComponents(button)] : [];
}
