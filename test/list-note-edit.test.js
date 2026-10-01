import test from 'node:test';
import assert from 'node:assert/strict';
import Blacklist from '../bot/models/Blacklist.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import { applyListEditNow, buildMovedEntryData } from '../bot/handlers/list/edit/applyNow.js';
import { buildApprovalMoveData } from '../bot/handlers/list/add/editApproval.js';

const AT = new Date('2026-07-02T00:00:00Z');
const NOTES = [
  { at: AT, reason: 'First', raid: 'Act4 Nor', byUserId: 'a', byName: 'KilZ' },
  { at: AT, reason: 'Second', raid: 'Kazeros Hard', byUserId: 'b', byName: 'Shiro' },
];
const existing = { _id: 'a'.repeat(24), name: 'Target', reason: 'Second', raid: 'Kazeros Hard', allCharacters: [], notes: NOTES };

test('both move paths carry the notes with the new reason on the latest note', () => {
  const moved = buildMovedEntryData({
    existing, targetType: 'white', editGuildId: 'g', editGuildDefaultScope: 'global',
    newReason: 'Edited', newRaid: '', newLogs: '', newImageUrl: '', newImageRehost: null, newScope: '',
    additionalNamesParsed: { added: [] },
  });
  assert.deepEqual(moved.notes.map(note => note.reason), ['First', 'Edited']);
  const approved = buildApprovalMoveData({ reason: 'Edited', raid: 'Act4 Hard' }, existing);
  assert.deepEqual(approved.notes.map(note => [note.reason, note.raid]), [['First', 'Act4 Nor'], ['Edited', 'Act4 Hard']]);
});

for (const stillListed of [true, false]) {
  test(`an in-place edit raced by a new note writes nothing (entry ${stillListed ? 'still listed' : 'gone'})`, async t => {
    let filter;
    let update;
    t.mock.method(Blacklist, 'updateOne', async (query, ops) => { filter = query; update = ops; return { matchedCount: 0 }; });
    t.mock.method(Blacklist, 'exists', async () => (stillListed ? { _id: existing._id } : null));
    t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
    const replies = [];
    await applyListEditNow({
      existing, currentType: 'black', targetType: 'black', targetScope: 'global', newReason: 'Edited',
      additionalNamesParsed: { added: [] }, isOwner: true, lang: 'en', client: {},
      interaction: { guild: { id: 'g' }, user: { id: 'owner', username: 'Owner' }, editReply: async reply => replies.push(reply) },
    });
    assert.deepEqual(filter, { _id: existing._id, notes: { $size: 2 } });
    assert.equal(update.$set['notes.1.reason'], 'Edited');
    assert.equal(update.$set.reason, 'Edited');
    assert.match(replies[0].embeds[0].toJSON().title, stillListed ? /new note/ : /original entry is gone/);
  });
}
