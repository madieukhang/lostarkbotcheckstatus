import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNoteAppend,
  buildNoteCountLine,
  buildNoteHistoryButton,
  buildNoteHistoryRows,
  carryNotesWithEdit,
  countEntryNotes,
  formatNoteDate,
  planLatestNoteEdit,
  readEntryNotes,
  withNoteCountLine,
} from '../bot/handlers/list/notes/entryNotes.js';

const JULY = new Date('2026-07-02T12:00:00Z');
const AUGUST = new Date('2026-08-14T12:00:00Z');
const note = (reason, at, extra = {}) => ({ at, reason, raid: 'Kazeros Hard', byUserId: 'u', byName: 'Shiro', ...extra });
const legacy = {
  _id: 'entry-id', name: 'Lovesiiii', reason: 'Đánh quá yếu', raid: 'Act4 Nor',
  addedAt: JULY, addedByUserId: 'k', addedByDisplayName: 'KilZ',
};
const twoNotes = { ...legacy, notes: [note('Đánh quá yếu', JULY, { raid: 'Act4 Nor', byName: 'KilZ' }), note('afk G1', AUGUST)] };

test('an entry saved before notes reads as one original note built from its add', () => {
  assert.deepEqual(readEntryNotes(legacy), [
    { at: JULY, reason: 'Đánh quá yếu', raid: 'Act4 Nor', byUserId: 'k', byName: 'KilZ' },
  ]);
  assert.equal(countEntryNotes(legacy), 1);
  assert.equal(countEntryNotes({ ...legacy, notes: [] }), 1);
  assert.equal(countEntryNotes(twoNotes), 2);
});

test('the first appended note writes the original note with it and pins "no notes yet"', () => {
  const added = note('vẫn thế', new Date('2026-10-01T00:00:00Z'));
  const { filter, update } = buildNoteAppend(legacy, added, { rosterNames: ['Lovesiiii', 'Pepsji'], set: { logsUrl: 'https://logs' } });
  assert.deepEqual(filter, { _id: 'entry-id', $or: [{ notes: { $exists: false } }, { notes: { $size: 0 } }] });
  assert.deepEqual(update.$set.notes, [readEntryNotes(legacy)[0], added]);
  assert.equal(update.$set.reason, 'vẫn thế');
  assert.equal(update.$set.raid, 'Kazeros Hard');
  assert.equal(update.$set.logsUrl, 'https://logs');
  assert.equal(update.$set.enrichmentSource, 'bible');
  assert.deepEqual(update.$addToSet, { allCharacters: { $each: ['Lovesiiii', 'Pepsji'] } });
  assert.equal(update.$push, undefined);
});

test('a later note is pushed under the note count read with the entry', () => {
  const added = note('vẫn thế', new Date('2026-10-01T00:00:00Z'));
  const { filter, update } = buildNoteAppend(twoNotes, added);
  assert.deepEqual(filter, { _id: 'entry-id', notes: { $size: 2 } });
  assert.deepEqual(update.$push, { notes: added });
  assert.equal(update.$set.notes, undefined);
  assert.equal(update.$addToSet, undefined);
  assert.equal(update.$set.enrichmentSource, undefined);
});

test('an edit rewrites only the latest note and pins the note count', () => {
  assert.deepEqual(planLatestNoteEdit(twoNotes, { reason: 'sửa', raid: '' }), {
    filter: { notes: { $size: 2 } },
    set: { 'notes.1.reason': 'sửa' },
  });
  assert.deepEqual(planLatestNoteEdit(legacy, { reason: 'sửa', raid: 'Act4 Hard' }), {
    filter: { $or: [{ notes: { $exists: false } }, { notes: { $size: 0 } }] },
    set: {},
  });
  assert.deepEqual(planLatestNoteEdit(twoNotes, { reason: '', raid: '' }), { filter: {}, set: {} });
});

test('a move carries the notes with the edit applied to the latest one', () => {
  const carried = carryNotesWithEdit(twoNotes, { reason: 'sửa', raid: '' });
  assert.deepEqual(carried.map(item => [item.reason, item.raid]), [['Đánh quá yếu', 'Act4 Nor'], ['sửa', 'Kazeros Hard']]);
  assert.equal(twoNotes.notes[1].reason, 'afk G1', 'the source notes stay untouched');
  assert.deepEqual(carryNotesWithEdit(legacy, { reason: 'sửa' }), []);
});

test('note dates read in each language, in UTC, and a missing date reads N/A', () => {
  assert.equal(formatNoteDate(JULY, 'en'), '02 Jul 2026');
  assert.equal(formatNoteDate(JULY, 'vi'), '02/07/2026');
  assert.equal(formatNoteDate(JULY, 'jp'), '2026/07/02');
  assert.equal(formatNoteDate(null, 'en'), 'N/A');
});

test('the count line and history button appear from two notes on', () => {
  assert.equal(buildNoteCountLine(legacy, 'en'), null);
  assert.equal(buildNoteHistoryButton('black', legacy, 'en'), null);
  assert.deepEqual(buildNoteHistoryRows('black', legacy, 'en'), []);
  assert.equal(buildNoteCountLine(twoNotes, 'en'), '-# 📜 2 notes · first on 02 Jul 2026');
  const button = buildNoteHistoryButton('black', twoNotes, 'en').toJSON();
  assert.equal(button.custom_id, 'listnote_history:black:entry-id:1');
  assert.equal(button.label, 'History · 2');
  assert.equal(buildNoteHistoryRows('black', twoNotes, 'en').length, 1);
});

test('the count line fits under a full reason', () => {
  const line = buildNoteCountLine(twoNotes, 'en');
  const value = withNoteCountLine('x'.repeat(1024), line);
  assert.equal(value.length, 1024);
  assert.ok(value.endsWith(`\n${line}`));
  assert.equal(withNoteCountLine('short', null), 'short');
});
