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
import { canChangeEntryWithoutApproval } from '../bot/handlers/list/helpers.js';

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
  // Each reason carries its own raid, so the grid does not repeat one of them.
  assert.equal(embed.fields[0].value, 'afk G1\n-# 🗡️ Act4 Nor');
  assert.equal(embed.fields[1].name, '✏️ Your new note');
  assert.equal(embed.fields[1].value, 'vẫn thế\n-# 🗡️ Kazeros Hard');
  assert.ok(!embed.fields.some(field => field.name.includes('Raid')));
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

function submitMemberServerAdd(existingEntry) {
  const calls = { rendered: [], sent: [], persisted: [] };
  const submission = submitListMutation({
    interaction: { guild: { id: 'guild' } },
    payload: { ...payload, scope: 'server', requestedByUserId: 'member' },
    lang: 'en',
    isRequesterAutoApproverFn: () => false,
    executeListAddToDatabase: async () => ({ ...duplicate(), existingEntry }),
    renderExecutionResultFn: async (_interaction, result) => calls.rendered.push(result),
    sendListAddApprovalToApprovers: async (_guild, sentPayload) => {
      calls.sent.push(sentPayload);
      return { success: true, deliveredApproverIds: ['approver'], deliveredDmMessages: [] };
    },
    PendingApprovalModel: { create: async doc => calls.persisted.push(doc) },
    connectDBFn: async () => {},
  });
  return { calls, submission };
}

test('a member server-scoped add that finds an entry outside their server goes to approval, with no note button', async () => {
  const outside = [
    { ...existing, scope: 'global' },
    { ...existing, scope: undefined },
    { ...existing, scope: 'server', guildId: 'other-guild' },
  ];
  for (const entry of outside) {
    const { calls, submission } = submitMemberServerAdd(entry);
    assert.equal((await submission).status, 'queued', `scope ${entry.scope}`);
    assert.equal(calls.rendered.length, 0, 'no duplicate card with a note button');
    assert.equal(calls.sent.length, 1);
    assert.equal(calls.sent[0].scope, 'server', 'the approver sees the scope the member asked for');
    assert.equal(calls.persisted.length, 1);
  }
});

test('a member server-scoped add that finds their own server entry keeps the note button', async () => {
  const { calls, submission } = submitMemberServerAdd({ ...existing, scope: 'server', guildId: 'guild', addedByUserId: 'member' });
  assert.equal((await submission).status, 'executed');
  assert.equal(calls.sent.length, 0);
  assert.match(addKeyOf(calls.rendered[0]), /^listnote_add:/);
});

test('a member server-scoped add that finds another member\'s server entry goes to approval, like /la-list edit', async () => {
  // A note replaces the entry's evidence and merges roster names, which
  // /la-list edit allows only the entry owner or an approver to do.
  const entries = [
    { ...existing, scope: 'server', guildId: 'guild', addedByUserId: 'someone-else' },
    { ...existing, scope: 'server', guildId: 'guild' },
  ];
  for (const entry of entries) {
    const { calls, submission } = submitMemberServerAdd(entry);
    assert.equal((await submission).status, 'queued', `owner ${entry.addedByUserId}`);
    assert.equal(calls.rendered.length, 0, 'no duplicate card with a note button');
    assert.equal(calls.sent.length, 1);
  }
});

test('a blank requester id never counts as the owner of an ownerless server entry', () => {
  // Stored entries default addedByUserId to '', so '' must not match ''.
  const ownerless = { ...existing, scope: 'server', guildId: 'guild', addedByUserId: '' };
  const blankRequester = { ...payload, scope: 'server', requestedByUserId: '' };
  assert.equal(canChangeEntryWithoutApproval(blankRequester, ownerless, () => false), false);
});

function setup(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const broadcasts = [];
  const handlers = createNoteHandlers({
    services: { broadcastListChange: async (...args) => { broadcasts.push(args); } },
    isRequesterAutoApproverFn: userId => userId === 'owner',
  });
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

test('a click that fails before saving leaves the card usable, and the note carries its card key', async t => {
  const { handlers } = setup(t);
  let reads = 0;
  const writes = [];
  t.mock.method(Blacklist, 'findById', () => ({
    lean: async () => { reads += 1; if (reads === 1) throw new Error('connection reset'); return existing; },
  }));
  t.mock.method(Blacklist, 'findOneAndUpdate', (filter, update) => { writes.push(update); return { lean: async () => ({ ...existing, notes: [] }) }; });
  const key = addKeyOf(attachNoteControls(duplicate(), payload, 'en'));

  await assert.rejects(handlers.handleListNoteAddButton(click(key, 'owner').interaction), /connection reset/);
  assert.equal(writes.length, 0);

  const retry = click(key, 'owner');
  await handlers.handleListNoteAddButton(retry.interaction);
  assert.equal(retry.calls.replies.length, 0, 'the card has not expired');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].$set.notes[1].requestId, key.slice('listnote_add:'.length));
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

test('a member card refuses the note when its entry left the member server after the card opened', async t => {
  const { handlers, broadcasts } = setup(t);
  const ownEntry = { ...existing, scope: 'server', guildId: 'guild' };
  const memberPayload = { ...payload, scope: 'server', requestedByUserId: 'member' };
  const key = addKeyOf(attachNoteControls({ ...duplicate(), existingEntry: ownEntry }, memberPayload, 'en'));
  t.mock.method(Blacklist, 'findById', () => ({ lean: async () => ({ ...ownEntry, scope: 'global', guildId: '' }) }));
  t.mock.method(Blacklist, 'findOneAndUpdate', () => assert.fail('a member note on a global entry needs approval'));
  const member = click(key, 'member');
  await handlers.handleListNoteAddButton(member.interaction);
  assert.match(member.calls.edits[0].embeds[0].toJSON().title, /needs approval/);
  assert.deepEqual(member.calls.edits[0].components, []);
  assert.equal(broadcasts.length, 0);
});

test('a member card refuses the note on another member\'s server entry', async t => {
  const { handlers, broadcasts } = setup(t);
  const othersEntry = { ...existing, scope: 'server', guildId: 'guild', addedByUserId: 'someone-else' };
  const memberPayload = { ...payload, scope: 'server', requestedByUserId: 'member' };
  const key = addKeyOf(attachNoteControls({ ...duplicate(), existingEntry: othersEntry }, memberPayload, 'en'));
  t.mock.method(Blacklist, 'findById', () => ({ lean: async () => othersEntry }));
  t.mock.method(Blacklist, 'findOneAndUpdate', () => assert.fail('a note on another member\'s entry needs approval'));
  const member = click(key, 'member');
  await handlers.handleListNoteAddButton(member.interaction);
  assert.match(member.calls.edits[0].embeds[0].toJSON().title, /needs approval/);
  assert.equal(broadcasts.length, 0);
});

test('a member still adds a note to their own server entry', async t => {
  const { handlers } = setup(t);
  const ownEntry = { ...existing, scope: 'server', guildId: 'guild', addedByUserId: 'member' };
  const memberPayload = { ...payload, scope: 'server', requestedByUserId: 'member' };
  let writes = 0;
  t.mock.method(Blacklist, 'findById', () => ({ lean: async () => ownEntry }));
  t.mock.method(Blacklist, 'findOneAndUpdate', () => { writes += 1; return { lean: async () => ({ ...ownEntry, notes: [] }) }; });
  const key = addKeyOf(attachNoteControls({ ...duplicate(), existingEntry: ownEntry }, memberPayload, 'en'));
  await handlers.handleListNoteAddButton(click(key, 'member').interaction);
  assert.equal(writes, 1);
});

test('an unknown or expired key answers that the card expired', async t => {
  const { handlers } = setup(t);
  const stale = click('listnote_add:000000000000', 'owner');
  await handlers.handleListNoteAddButton(stale.interaction);
  assert.match(JSON.stringify(stale.calls.replies[0]), /expired/);
});
