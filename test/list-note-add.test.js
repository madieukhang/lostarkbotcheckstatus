import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { attachNoteControls } from '../bot/handlers/list/notes/pendingNotes.js';
import { createNoteHandlers } from '../bot/handlers/list/notes/index.js';
import { submitListMutation } from '../bot/handlers/list/services/mutationFlow.js';
import { buildDuplicateListAddResult } from '../bot/handlers/list/services/addExecutor.js';

const AT = new Date('2026-07-02T00:00:00Z');
const existing = {
  _id: 'a'.repeat(24), name: 'Lovesiiii', scope: 'global', reason: 'afk G1', raid: 'Act4 Nor',
  allCharacters: ['Lovesiiii'], addedAt: AT, addedByDisplayName: 'KilZ',
};
const payload = {
  type: 'black', name: 'Pepsji', reason: 'vẫn thế', raid: 'Kazeros Hard', scope: 'global', guildId: 'guild',
  requestedByUserId: 'owner', requestedByDisplayName: 'meow', requestedByTag: 'meow#0', lang: 'en',
};
const duplicate = () => ({ ok: false, isDuplicate: true, existingEntry: existing, rosterNames: ['Lovesiiii', 'Pepsji'], rosterCharacters: [], embeds: [{}] });
const addKeyOf = result => result.components[0].toJSON().components[0].custom_id;

test('the direct duplicate card names the new note with its raid and keeps the fetched roster', () => {
  const result = buildDuplicateListAddResult({
    existed: existing, name: 'Pepsji', labelCap: 'Blacklist', type: 'black', lang: 'en',
    typedReason: 'vẫn thế', typedRaid: 'Kazeros Hard', rosterNames: ['Lovesiiii', 'Pepsji'], rosterCharacters: [],
  });
  const embed = result.embeds[0].toJSON();
  assert.equal(embed.fields[1].name, '✏️ Your new note');
  assert.equal(embed.fields[1].value, 'vẫn thế\n-# 🗡️ Kazeros Hard');
  assert.match(embed.footer.text, /Add to history/);
  assert.deepEqual(result.rosterNames, ['Lovesiiii', 'Pepsji']);
  assert.deepEqual(result.rosterCharacters, []);
});

test('only a duplicate result gets the Add to history button', () => {
  const plain = { ok: true, embeds: [{}] };
  assert.equal(attachNoteControls(plain, payload, 'en'), plain);
  const result = attachNoteControls(duplicate(), payload, 'en');
  assert.match(addKeyOf(result), /^listnote_add:[0-9a-f]{12}$/);
  assert.equal(result.components[0].toJSON().components.length, 1, 'one stored note shows no History button');
});

test('a duplicate from a direct add renders with the note controls', async () => {
  const rendered = [];
  await submitListMutation({
    interaction: {}, payload, lang: 'en',
    isRequesterAutoApproverFn: () => true,
    executeListAddToDatabase: async () => duplicate(),
    renderExecutionResultFn: async (_interaction, result) => rendered.push(result),
  });
  assert.match(addKeyOf(rendered[0]), /^listnote_add:/);
});

function setup(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const broadcasts = [];
  const handlers = createNoteHandlers({ services: { broadcastListChange: async (...args) => { broadcasts.push(args); } } });
  return { broadcasts, handlers };
}

function click(customId, userId) {
  const calls = { replies: [], edits: [], updated: 0 };
  return {
    calls,
    interaction: {
      customId, user: { id: userId }, guildId: 'guild',
      reply: async value => calls.replies.push(value),
      deferUpdate: async () => { calls.updated += 1; },
      editReply: async value => calls.edits.push(value),
    },
  };
}

test('someone else cannot use the card, and the owner still can afterwards', async t => {
  const { handlers } = setup(t);
  const saved = { ...existing, reason: 'vẫn thế', raid: 'Kazeros Hard', allCharacters: ['Lovesiiii', 'Pepsji'],
    notes: [{ at: AT, reason: 'afk G1', raid: 'Act4 Nor', byUserId: '', byName: 'KilZ' }, { at: new Date(), reason: 'vẫn thế', raid: 'Kazeros Hard', byUserId: 'owner', byName: 'meow' }] };
  const writes = [];
  t.mock.method(Blacklist, 'findById', () => ({ lean: async () => existing }));
  t.mock.method(Blacklist, 'findOneAndUpdate', (filter, update) => { writes.push({ filter, update }); return { lean: async () => saved }; });
  const key = addKeyOf(attachNoteControls(duplicate(), payload, 'en'));

  const outsider = click(key, 'outsider');
  await handlers.handleListNoteAddButton(outsider.interaction);
  assert.equal(outsider.calls.replies.length, 1);
  assert.equal(writes.length, 0);

  const owner = click(key, 'owner');
  await handlers.handleListNoteAddButton(owner.interaction);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].update.$set.reason, 'vẫn thế');
  assert.deepEqual(writes[0].update.$addToSet, { allCharacters: { $each: ['Lovesiiii', 'Pepsji'] } });
  assert.match(owner.calls.edits[0].embeds[0].toJSON().title, /Note added · Lovesiiii/);
});

test('a second click finds the card used up and writes nothing', async t => {
  const { handlers, broadcasts } = setup(t);
  let writes = 0;
  t.mock.method(Blacklist, 'findById', () => ({ lean: async () => existing }));
  t.mock.method(Blacklist, 'findOneAndUpdate', () => { writes += 1; return { lean: async () => ({ ...existing, notes: [] }) }; });
  const key = addKeyOf(attachNoteControls(duplicate(), payload, 'en'));
  await handlers.handleListNoteAddButton(click(key, 'owner').interaction);
  const second = click(key, 'owner');
  await handlers.handleListNoteAddButton(second.interaction);
  assert.equal(writes, 1);
  assert.equal(second.calls.replies.length, 1);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0][0], 'noted');
});

test('an entry removed before the click is not recreated', async t => {
  const { handlers, broadcasts } = setup(t);
  t.mock.method(Blacklist, 'findById', () => ({ lean: async () => null }));
  t.mock.method(Blacklist, 'findOneAndUpdate', () => assert.fail('a gone entry takes no note'));
  const key = addKeyOf(attachNoteControls(duplicate(), payload, 'en'));
  const owner = click(key, 'owner');
  await handlers.handleListNoteAddButton(owner.interaction);
  assert.match(owner.calls.edits[0].embeds[0].toJSON().title, /original entry is gone/);
  assert.equal(broadcasts.length, 0);
});

test('an unknown or expired key answers that the card expired', async t => {
  const { handlers } = setup(t);
  const stale = click('listnote_add:000000000000', 'owner');
  await handlers.handleListNoteAddButton(stale.interaction);
  assert.match(JSON.stringify(stale.calls.replies[0]), /expired/);
});
