import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Blacklist from '../bot/models/Blacklist.js';
import { appendEntryNote, listAddedAlts } from '../bot/handlers/list/notes/appendNote.js';

let mongo;
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Blacklist.init();
});
test.after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test.beforeEach(async () => { await Blacklist.deleteMany({}); });

const payload = (reason, extra = {}) => ({
  reason, raid: 'Kazeros Hard', requestedByUserId: 'u1', requestedByDisplayName: 'Reporter', ...extra,
});

test('the first note on an entry saved before notes keeps its add as the original note', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'First report', raid: 'Act4 Nor', addedByDisplayName: 'KilZ', allCharacters: ['Target'] });
  await Blacklist.collection.updateOne({ _id: created._id }, { $unset: { notes: '' } });
  const entry = await Blacklist.findById(created._id).lean();
  const saved = await appendEntryNote({ model: Blacklist, entry, payload: payload('Second report'), rosterNames: ['Target', 'Newalt'] });
  assert.deepEqual(saved.notes.map(note => [note.reason, note.raid, note.byName]), [
    ['First report', 'Act4 Nor', 'KilZ'], ['Second report', 'Kazeros Hard', 'Reporter'],
  ]);
  assert.equal(saved.reason, 'Second report');
  assert.equal(saved.raid, 'Kazeros Hard');
  assert.equal(saved.name, 'Target');
  assert.deepEqual(saved.allCharacters, ['Target', 'Newalt']);
  assert.deepEqual(listAddedAlts(entry, saved), ['Newalt']);
  assert.equal(saved.enrichmentSource, 'bible');
});

test('a note saved in between is kept: the stale write re-reads and appends after it', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'First' });
  const stale = await Blacklist.findById(created._id).lean();
  await appendEntryNote({ model: Blacklist, entry: stale, payload: payload('Second') });
  const saved = await appendEntryNote({ model: Blacklist, entry: stale, payload: payload('Third') });
  assert.deepEqual(saved.notes.map(note => note.reason), ['First', 'Second', 'Third']);
  assert.equal(saved.reason, 'Third');
});

test('an edit landing before the first note is kept as the original note', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'A', raid: 'Act4 Nor' });
  const stale = await Blacklist.findById(created._id).lean();
  // A /la-list edit on an entry without notes rewrites only reason and raid.
  await Blacklist.updateOne({ _id: created._id }, { $set: { reason: 'B', raid: 'Act4 Hard' } });
  const saved = await appendEntryNote({ model: Blacklist, entry: stale, payload: payload('C') });
  assert.deepEqual(saved.notes.map(note => [note.reason, note.raid]), [['B', 'Act4 Hard'], ['C', 'Kazeros Hard']]);
});

test('reports saved at the same moment all land', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'First' });
  const stale = await Blacklist.findById(created._id).lean();
  const results = await Promise.all(['R1', 'R2', 'R3'].map(reason =>
    appendEntryNote({ model: Blacklist, entry: stale, payload: payload(reason) })));
  assert.ok(results.every(Boolean), 'no report reads as a removed entry');
  const stored = await Blacklist.findById(created._id).lean();
  assert.deepEqual(stored.notes.map(note => note.reason).sort(), ['First', 'R1', 'R2', 'R3']);
});

test('a retried save of the same request finds its note instead of adding it twice', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'First' });
  const stale = await Blacklist.findById(created._id).lean();
  const first = await appendEntryNote({ model: Blacklist, entry: stale, payload: payload('Second'), requestId: 'req-1' });
  const retried = await appendEntryNote({ model: Blacklist, entry: stale, payload: payload('Second'), requestId: 'req-1' });
  assert.deepEqual(retried.notes.map(note => note.reason), ['First', 'Second']);
  assert.deepEqual(retried.notes, first.notes);
});

test('a removed entry takes no note', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'First' });
  const entry = await Blacklist.findById(created._id).lean();
  await Blacklist.deleteOne({ _id: created._id });
  assert.equal(await appendEntryNote({ model: Blacklist, entry, payload: payload('Second') }), null);
});

test('a new screenshot replaces the evidence, and a note without one keeps it', async () => {
  const created = await Blacklist.create({ name: 'Target', reason: 'First', imageMessageId: 'old', imageChannelId: 'archive' });
  const entry = await Blacklist.findById(created._id).lean();
  const kept = await appendEntryNote({ model: Blacklist, entry, payload: payload('Second') });
  assert.equal(kept.imageMessageId, 'old');
  const replaced = await appendEntryNote({ model: Blacklist, entry: kept, payload: payload('Third', { imageMessageId: 'new', imageChannelId: 'archive' }) });
  assert.equal(replaced.imageMessageId, 'new');
  assert.equal(replaced.imageUrl, '');
});
