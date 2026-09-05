import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PendingApproval from '../bot/models/PendingApproval.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { buildApprovalResultRow } from '../bot/handlers/list/helpers.js';
import { createListAddOverwriteButtonHandler } from '../bot/handlers/list/add/overwriteButton.js';

test('keep-existing rejects an unassigned user without consuming the approver request', async (t) => {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  let pending = { requestId: 'approval-1', name: 'Artist', approverIds: ['approver'] };
  const filters = [];
  t.mock.method(PendingApproval, 'findOneAndDelete', (filter) => ({ lean: async () => {
    filters.push(filter);
    if (!pending || (filter.approverIds && !pending.approverIds.includes(filter.approverIds))) return null;
    const result = pending;
    pending = null;
    return result;
  } }));
  t.mock.method(PendingApproval, 'exists', async () => Boolean(pending));
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
    reply: async payload => replies.push(payload),
    editReply: async payload => edits.push(payload),
    deferUpdate: async () => { deferred += 1; },
  };

  await handler(interaction);
  await handler({ ...interaction, customId: 'listadd_overwrite:approval-1' });
  assert.ok(pending, 'An unassigned click must leave the pending approval intact');
  assert.equal(replies.length, 2);
  assert.equal(deferred, 0);
  assert.equal(edits.length, 0);
  assert.equal(notifications.length, 0);

  await handler({ ...interaction, user: { id: 'approver' } });
  assert.equal(pending, null);
  assert.equal(deferred, 1);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0][1], { ok: false, isDuplicate: true });
  assert.equal(notifications[0][2], true);
  assert.deepEqual(filters.map(filter => filter.approverIds), ['outsider', 'outsider', 'approver']);
  assert.deepEqual(edits[0].components[0].toJSON(), buildApprovalResultRow('Kept Existing', 'en').toJSON());
  assert.deepEqual(synced[0].components[0].toJSON(), buildApprovalResultRow('Kept Existing', 'jp').toJSON());

  await handler({ ...interaction, user: { id: 'approver' } });
  assert.equal(notifications.length, 1, 'an already consumed request must not notify twice');
});
