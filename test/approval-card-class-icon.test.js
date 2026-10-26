import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import UserPreference from '../bot/models/UserPreference.js';
import { createAddHandlers } from '../bot/handlers/list/add/index.js';
import { createListAddCommandHandler } from '../bot/handlers/list/add/command.js';
import { handleApprovedEditRequest } from '../bot/handlers/list/add/editApproval.js';
import { createListAddOverwriteButtonHandler } from '../bot/handlers/list/add/overwriteButton.js';
import { createQuickAddHandlers } from '../bot/handlers/list/quickadd/index.js';
import { createApprovalServices } from '../bot/handlers/list/services/approvals.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { disconnectDB } from '../bot/db.js';
import { mockPendingApprovalModel } from './helpers/pending-approval-model.js';

// Class emoji are bootstrapped from the application at runtime, so in tests
// the class name stands in for the icon.
const CLASSED_NAME = 'Berserker **[Burgerxucxich](';

const PAYLOAD = {
  requestId: 'classed', action: 'add', name: 'Burgerxucxich', type: 'black', scope: 'global',
  raid: '', reason: 'Left after the first wipe.', guildId: 'origin-guild',
  requestedByUserId: 'requester', requestedByDisplayName: 'Rainfox', approverIds: ['approver'],
};

function snapshotModel(lean) {
  const calls = [];
  return {
    calls,
    findOne(filter) {
      calls.push(filter);
      return { collation() { return this; }, lean };
    },
  };
}

test('the approver DM shows the class of the requested character', async () => {
  const sent = [];
  const RosterSnapshotModel = snapshotModel(async () => ({ name: 'Burgerxucxich', classId: 'berserker' }));
  const services = createApprovalServices({
    client: { users: { fetch: async (id) => ({ id, send: async (message) => { sent.push(message); return { channelId: 'dm', id: 'msg' }; } }) } },
    getUserLanguageFn: async () => 'en',
    getApproverRecipientIdsFn: () => ['approver'],
    RosterSnapshotModel,
  });

  const result = await services.sendListAddApprovalToApprovers({ id: 'origin-guild', name: 'Guild' }, PAYLOAD);

  assert.equal(result.success, true);
  assert.deepEqual(RosterSnapshotModel.calls, [{ name: 'Burgerxucxich' }]);
  assert.ok(sent[0].embeds[0].toJSON().description.includes(CLASSED_NAME));
  // The requester's own copy reuses this read instead of a second one.
  assert.deepEqual(result.snapshot, { name: 'Burgerxucxich', classId: 'berserker' });
});

test('the approver DM still goes out when the snapshot read fails', async () => {
  const sent = [];
  const services = createApprovalServices({
    client: { users: { fetch: async (id) => ({ id, send: async (message) => { sent.push(message); return { channelId: 'dm', id: 'msg' }; } }) } },
    getUserLanguageFn: async () => 'en',
    getApproverRecipientIdsFn: () => ['approver'],
    RosterSnapshotModel: snapshotModel(async () => { throw new Error('db down'); }),
  });

  const result = await services.sendListAddApprovalToApprovers({ id: 'origin-guild', name: 'Guild' }, PAYLOAD);

  assert.equal(result.success, true);
  assert.ok(sent[0].embeds[0].toJSON().description.includes('**[Burgerxucxich]('));
});

function stubEnglishViewer(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

function recordLookups() {
  const lookups = [];
  return {
    lookups,
    findRosterSnapshot: async (name) => {
      lookups.push(name);
      return { name, classId: 'berserker' };
    },
  };
}

async function decide(t, customId) {
  stubEnglishViewer(t);
  mockPendingApprovalModel(t, PendingApproval, PAYLOAD);

  const { lookups, findRosterSnapshot } = recordLookups();
  const handlers = createAddHandlers({
    client: {},
    services: {
      executeListAddToDatabase: async () => ({ ok: true }),
      syncApproverDmMessages: async () => {},
      notifyRequesterAboutDecision: async () => {},
      broadcastListChange: async () => {},
      findRosterSnapshot,
    },
  });
  const handler = customId.startsWith('listadd_keep')
    ? handlers.handleListAddOverwriteButton
    : handlers.handleListAddApprovalButton;
  const edits = [];
  await handler({
    customId, user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
    client: { guilds: { cache: new Map([['origin-guild', { name: 'Thaemine Nightwatch' }]]) } },
    deferUpdate: async () => {}, editReply: async (payload) => { edits.push(payload); },
    reply: async () => {}, followUp: async () => {},
  });
  return { lookups, embed: edits.at(-1).embeds[0].toJSON() };
}

for (const [customId, outcome] of [
  ['listadd_approve:classed', 'Approved'],
  ['listadd_reject:classed', 'Rejected'],
  ['listadd_keep:classed', 'Kept existing'],
]) {
  test(`the decided approver card keeps the class icon when ${outcome.toLowerCase()}`, async (t) => {
    const { lookups, embed } = await decide(t, customId);

    assert.match(embed.title, new RegExp(`· ${outcome}$`, 'i'));
    assert.deepEqual(lookups, ['Burgerxucxich']);
    assert.ok(embed.description.includes(CLASSED_NAME), embed.description);
  });
}

test('an approved edit keeps the class icon on the decided card', async (t) => {
  const entry = { _id: 'a'.repeat(24), name: 'Burgerxucxich', reason: 'Old', scope: 'global', allCharacters: [] };
  t.mock.method(Blacklist, 'findById', async () => entry);
  t.mock.method(Blacklist, 'updateOne', async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }));
  t.mock.method(Blacklist, 'exists', async () => null);
  const { lookups, findRosterSnapshot } = recordLookups();
  const replies = [];

  await handleApprovedEditRequest({
    payload: { ...PAYLOAD, action: 'edit', existingEntryId: entry._id, currentType: 'black', reason: 'New' },
    lang: 'en',
    interaction: {
      deferred: true, user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
      client: { guilds: { cache: new Map() } }, editReply: async (reply) => { replies.push(reply); },
    },
    completeApproval: async () => {},
    beforeWrite: async () => {},
    syncApproverDmMessages: async () => {},
    broadcastListChange: async () => {},
    notifyRequesterAboutDecision: async () => {},
    findRosterSnapshot,
  });

  const embed = replies.at(-1).embeds[0].toJSON();
  assert.match(embed.title, /· Approved$/);
  assert.deepEqual(lookups, ['Burgerxucxich']);
  assert.ok(embed.description.includes(CLASSED_NAME), embed.description);
});

test('a report added to history keeps the class icon on the decided card', async (t) => {
  stubEnglishViewer(t);
  mockPendingApprovalModel(t, PendingApproval, { ...PAYLOAD, duplicateEntryId: 'original' });
  const original = { _id: 'original', name: 'Burgerxucxich', reason: 'Old', allCharacters: [], scope: 'global' };
  t.mock.method(Blacklist, 'findById', () => Object.assign(Promise.resolve(original), { lean: async () => original }));
  t.mock.method(Blacklist, 'findOneAndUpdate', () => ({ lean: async () => ({ ...original, reason: PAYLOAD.reason }) }));
  t.mock.method(TrustedUser, 'findOne', () => ({ collation() { return this; }, lean: async () => null }));
  const { lookups, findRosterSnapshot } = recordLookups();
  const edits = [];

  await createListAddOverwriteButtonHandler({
    buildRosterCharactersFn: async () => ({ hasValidRoster: true, allCharacters: ['Burgerxucxich'] }),
    syncApproverDmMessages: async () => {},
    broadcastListChange: async () => {},
    notifyRequesterAboutDecision: async () => {},
    findRosterSnapshot,
  })({
    customId: 'listadd_overwrite:classed', user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
    client: { guilds: { cache: new Map() } },
    deferUpdate: async () => {}, editReply: async (value) => { edits.push(value); },
  });

  const final = edits.at(-1);
  assert.equal(final.components[0].toJSON().components[0].label, 'Added to History');
  assert.deepEqual(lookups, ['Burgerxucxich']);
  assert.ok(final.embeds[0].toJSON().description.includes(CLASSED_NAME));
});

const QUEUED_REQUESTER_HERO = 'I sent Berserker **[Mokoko](';

function deliveredWithSnapshot() {
  return async () => ({
    success: true, deliveredApproverIds: ['senior'], deliveredDmMessages: [],
    snapshot: { name: 'Mokoko', classId: 'berserker' },
  });
}

test("a member's /la-list add shows the class on their sent-for-approval card", async (t) => {
  stubEnglishViewer(t);
  t.mock.method(PendingApproval, 'create', async (doc) => doc);
  t.mock.method(PendingApproval, 'updateOne', async () => ({}));
  const replies = [];
  const handleListAddCommand = createListAddCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: deliveredWithSnapshot(),
    executeListAddToDatabase: async () => assert.fail('a member add waits for an approver'),
  });

  await handleListAddCommand({
    user: { id: 'member-1', username: 'Member', tag: 'Member#0001' },
    guild: { id: 'guild', name: 'Guild' },
    channelId: 'channel',
    options: {
      getString: (key) => ({ type: 'black', name: 'Mokoko', reason: 'Left mid-raid', scope: 'global' })[key] ?? null,
      getAttachment: () => null,
    },
    deferReply: async () => {},
    fetchReply: async () => ({ id: 'reply-1' }),
    editReply: async (payload) => { replies.push(payload); },
  });

  const embed = replies.at(-1).embeds[0].toJSON();
  assert.ok(embed.description.startsWith(QUEUED_REQUESTER_HERO), embed.description);
});

test("a member's quick add shows the class on their sent-for-approval card", async (t) => {
  stubEnglishViewer(t);
  t.mock.method(PendingApproval, 'create', async (doc) => doc);
  const replies = [];
  const { handleQuickAddModal } = createQuickAddHandlers({ services: {
    sendListAddApprovalToApprovers: deliveredWithSnapshot(),
    executeListAddToDatabase: async () => assert.fail('a member add waits for an approver'),
  } });
  const values = { quickadd_type: 'black', quickadd_reason: 'Left mid-raid', quickadd_raid: '' };

  await handleQuickAddModal({
    customId: 'quickadd_modal:Mokoko',
    fields: { getTextInputValue: (id) => values[id] },
    user: { id: 'requester-1', tag: 'requester#0001', username: 'requester' },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  });

  const embed = replies.at(-1).embeds[0].toJSON();
  assert.ok(embed.description.startsWith(QUEUED_REQUESTER_HERO), embed.description);
});
