import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PendingApproval from '../bot/models/PendingApproval.js';
import UserPreference from '../bot/models/UserPreference.js';
import { createAddHandlers } from '../bot/handlers/list/add/index.js';
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

async function decide(t, customId) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  mockPendingApprovalModel(t, PendingApproval, PAYLOAD);

  const lookups = [];
  const handlers = createAddHandlers({
    client: {},
    services: {
      executeListAddToDatabase: async () => ({ ok: true }),
      syncApproverDmMessages: async () => {},
      notifyRequesterAboutDecision: async () => {},
      broadcastListChange: async () => {},
      findRosterSnapshot: async (name) => {
        lookups.push(name);
        return { name, classId: 'berserker' };
      },
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
