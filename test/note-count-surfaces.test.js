import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import { disconnectDB } from '../bot/db.js';
import { editWithListEntryDetails } from '../bot/handlers/list/check/index.js';
import { applyListEditNow } from '../bot/handlers/list/edit/applyNow.js';
import { buildCheckEntryDetailsEmbed } from '../bot/handlers/list/check/ui.js';
import { buildEvidenceEmbed } from '../bot/handlers/list/view/ui.js';
import { buildListEditSuccessEmbed, decorateListEntry } from '../bot/handlers/list/helpers.js';
import { buildBroadcastPayload } from '../bot/handlers/list/services/broadcasts.js';
import { buildDuplicateReasonFields } from '../bot/handlers/list/duplicate-ui.js';

const AT = new Date('2026-07-02T00:00:00Z');
const base = { _id: 'd'.repeat(24), name: 'Lovesiiii', reason: 'afk G1', raid: 'Kazeros Hard', scope: 'global', allCharacters: [], addedAt: AT };
// Every caller of the detail cards passes an entry decorated with its list.
const single = decorateListEntry(base, 'black');
const noted = {
  ...single,
  notes: [
    { at: AT, reason: 'Đánh quá yếu', raid: 'Act4 Nor', byUserId: 'a', byName: 'KilZ' },
    { at: AT, reason: 'afk G1', raid: 'Kazeros Hard', byUserId: 'b', byName: 'Shiro' },
  ],
};
const LINE = '-# 📜 2 notes · first on 02 Jul 2026';
const reasonOf = embed => embed.toJSON().fields.find(field => field.name.includes('📝') || /Reason/.test(field.name)).value;

for (const [label, render] of [
  ['check details', entry => buildCheckEntryDetailsEmbed(entry, { lang: 'en' })],
  ['list view detail', entry => buildEvidenceEmbed(entry, '', { lang: 'en' })],
  ['edit success', entry => buildListEditSuccessEmbed(entry, { type: 'black', editorName: 'Owner', lang: 'en' })],
]) {
  test(`${label}: the reason gains the count line only from two notes`, () => {
    assert.ok(!reasonOf(render(single)).includes('📜'));
    assert.equal(reasonOf(render(noted)), `afk G1\n${LINE}`);
  });
}

test('the duplicate cards count the stored notes under the stored reason', () => {
  assert.equal(buildDuplicateReasonFields(noted, 'new', 'en')[0].value, `afk G1\n${LINE}`);
  assert.equal(buildDuplicateReasonFields(single, 'new', 'en')[0].value, 'afk G1');
});

const HISTORY_ID = `listnote_history:black:${'d'.repeat(24)}:1`;
const stored = { ...base, notes: noted.notes };
const noSnapshots = () => ({ collation() { return this; }, lean: async () => [] });

test('the check details reply carries the History button from two notes', async t => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(() => disconnectDB());
  t.mock.method(Blacklist, 'findOne', () => ({ lean: async () => stored }));
  t.mock.method(RosterSnapshot, 'find', noSnapshots);
  const edits = [];
  await editWithListEntryDetails(
    { guildId: 'g', guild: { id: 'g' }, user: { id: 'viewer' }, editReply: async value => edits.push(value) },
    { listType: 'black', id: base._id },
    { client: {}, lang: 'en' },
  );
  assert.equal(edits[0].components[0].toJSON().components[0].custom_id, HISTORY_ID);
});

test('the edit result carries the History button from two notes', async t => {
  t.mock.method(Blacklist, 'updateOne', async () => ({ matchedCount: 1 }));
  t.mock.method(RosterSnapshot, 'find', noSnapshots);
  const replies = [];
  await applyListEditNow({
    existing: stored, currentType: 'black', targetType: 'black', targetScope: 'global', newReason: 'Edited',
    additionalNamesParsed: { added: [] }, isOwner: true, lang: 'en', client: {},
    interaction: { guild: { id: 'g' }, user: { id: 'owner', username: 'Owner' }, editReply: async reply => replies.push(reply) },
  });
  assert.equal(replies[0].components[0].toJSON().components[0].custom_id, HISTORY_ID);
});

test('broadcasts carry the count line and a History button beside evidence, except a removal', () => {
  const card = action => buildBroadcastPayload({ action, entry: { ...noted, imageMessageId: 'm', imageChannelId: 'c' }, type: 'black', statMap: new Map(), lang: 'en', previousEntry: noted });
  const added = card('added');
  assert.ok(added.embeds[0].toJSON().fields[0].value.endsWith(LINE));
  assert.deepEqual(added.components[0].toJSON().components.map(button => button.custom_id), [
    'listbroadcast_evidence:c:m', `listnote_history:black:${'d'.repeat(24)}:1`,
  ]);
  const removed = card('removed');
  assert.ok(!removed.embeds[0].toJSON().fields[0].value.includes('📜'));
  assert.equal(removed.components[0].toJSON().components.length, 1);
});
