import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PendingApproval from '../bot/models/PendingApproval.js';
import UserPreference from '../bot/models/UserPreference.js';
import Blacklist from '../bot/models/Blacklist.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { buildApprovalResultRow } from '../bot/handlers/list/helpers.js';
import { createListAddOverwriteButtonHandler } from '../bot/handlers/list/add/overwriteButton.js';
import { mockPendingApprovalModel } from './helpers/pending-approval-model.js';

test('keep-existing rejects an unassigned user without consuming the approver request', async (t) => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const pending = mockPendingApprovalModel(t, PendingApproval, { requestId: 'approval-1', name: 'Artist', approverIds: ['approver'] });
  const edits = [];
  const replies = [];
  const synced = [];
  const notifications = [];
  let deferred = 0;
  const handler = createListAddOverwriteButtonHandler({
    syncApproverDmMessages: async (_payload, build) => synced.push(build('jp')),
    broadcastListChange: async () => assert.fail('Keep-existing must not broadcast a mutation'),
    notifyRequesterAboutDecision: async (...args) => { notifications.push(args); },
  });
  const interaction = {
    customId: 'listadd_keep:approval-1',
    user: { id: 'outsider' },
    message: { id: 'dm-1' },
    client: { guilds: { cache: new Map() } },
    reply: async payload => replies.push(payload),
    editReply: async payload => edits.push(payload),
    deferUpdate: async () => { deferred += 1; },
  };

  await handler(interaction);
  await handler({ ...interaction, customId: 'listadd_overwrite:approval-1' });
  assert.ok(pending.get(), 'An unassigned click must leave the pending approval intact');
  assert.equal(replies.length, 2);
  assert.equal(deferred, 0);
  assert.equal(edits.length, 0);
  assert.equal(notifications.length, 0);

  await handler({ ...interaction, user: { id: 'approver' } });
  assert.equal(pending.get(), null);
  assert.equal(deferred, 1);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0][1], { ok: false, isDuplicate: true });
  assert.equal(notifications[0][2], true);
  assert.deepEqual(pending.calls.claims.map(filter => filter.approverIds), ['approver']);
  assert.deepEqual(edits[0].components[0].toJSON(), buildApprovalResultRow('Kept Existing', 'en').toJSON());
  assert.deepEqual(synced[0].components[0].toJSON(), buildApprovalResultRow('Kept Existing', 'jp').toJSON());

  await handler({ ...interaction, user: { id: 'approver' } });
  assert.equal(notifications.length, 1, 'an already consumed request must not notify twice');
});

for (const protectedAlt of [true, false]) {
  test(`Add to history rechecks refreshed roster names against Trusted (protected=${protectedAlt})`, async t => {
    t.mock.method(mongoose, 'connect', async () => mongoose);
    t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
    clearUserLanguageCache();
    t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
    const payload = {
      requestId: 'pending', name: 'Newmain', type: 'black', duplicateEntryId: 'original',
      approverIds: ['officer'], scope: 'global', reason: 'New report', raid: 'Kazeros Hard',
      requestedByUserId: 'requester', requestedByDisplayName: 'Requester',
    };
    mockPendingApprovalModel(t, PendingApproval, payload);
    const original = { _id: 'original', name: 'Original', reason: 'Old', allCharacters: ['Originalalt'], scope: 'server', guildId: 'original-guild' };
    const saved = { ...original, reason: 'New report', allCharacters: ['Originalalt', 'Newmain', 'Protectedalt'] };
    const writes = [];
    t.mock.method(Blacklist, 'findById', () => Object.assign(Promise.resolve(original), { lean: async () => original }));
    t.mock.method(Blacklist, 'findOneAndUpdate', (filter, update) => { writes.push({ filter, update }); return { lean: async () => saved }; });
    t.mock.method(TrustedUser, 'findOne', query => {
      assert.match(JSON.stringify(query), /Protectedalt/);
      return { collation() { return this; }, lean: async () => protectedAlt ? { name: 'Protectedalt', reason: 'Newly trusted' } : null };
    });
    const edits = [];
    const broadcasts = [];
    let decision;
    await createListAddOverwriteButtonHandler({
      buildRosterCharactersFn: async () => ({ hasValidRoster: true, allCharacters: ['Newmain', 'Protectedalt'] }),
      syncApproverDmMessages: async () => {},
      broadcastListChange: async (...args) => { broadcasts.push(args); },
      notifyRequesterAboutDecision: async (_payload, result) => { decision = result; },
    })({
      customId: 'listadd_overwrite:pending', user: { id: 'officer', tag: 'Officer' }, message: { id: 'dm' },
      client: { guilds: { cache: new Map() } },
      deferUpdate: async () => {}, editReply: async value => { edits.push(value); },
    });
    assert.equal(writes.length, protectedAlt ? 0 : 1);
    assert.equal(broadcasts.length, protectedAlt ? 0 : 1);
    if (protectedAlt) {
      assert.deepEqual(decision, { ok: false });
      assert.match(JSON.stringify(edits[0].embeds[0].toJSON()), /Newly trusted/);
      return;
    }
    assert.equal(writes[0].update.$set.reason, 'New report');
    assert.equal(writes[0].update.$set.name, undefined, 'the entry keeps its name');
    assert.equal(writes[0].update.$set.scope, undefined, 'the entry keeps its scope');
    assert.equal(writes[0].update.$set.notes[1].byName, 'Requester', 'the requester wrote the note');
    assert.equal(broadcasts[0][0], 'noted');
    assert.deepEqual(broadcasts[0][3].newAltNames, ['Newmain', 'Protectedalt']);
    assert.deepEqual(decision, { ok: true, isNoted: true });
    assert.equal(edits.at(-1).components[0].toJSON().components[0].label, 'Added to History');
  });
}
