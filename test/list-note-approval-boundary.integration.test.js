import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Blacklist from '../bot/models/Blacklist.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import { createListAddCommandHandler } from '../bot/handlers/list/add/command.js';
import { createListAddExecutor } from '../bot/handlers/list/services/addExecutor.js';
import { isRequesterAutoApprover } from '../bot/handlers/list/helpers.js';
import { bibleClient } from '../bot/services/roster/bibleClient.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';

// The real slash handler and add executor on a disposable database: a member's
// server-scoped add must not reach an approved global entry without an approver.
test('a member server-scoped add on a global entry is sent for approval and leaves the entry unchanged', async t => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('note_approval_boundary'));
  t.after(async () => { await disconnectDB(); await mongo.stop(); });
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external I/O'); });
  t.mock.method(bibleClient, 'fetch', async () => new Response(
    '<a href="/character/NA/Audittarget"><div class="text-lg font-semibold">Audittarget<span>1750</span><span>100</span></div></a>'
  ));
  await Promise.all([Blacklist.init(), TrustedUser.init(), PendingApproval.init()]);
  clearUserLanguageCache();
  const original = await Blacklist.create({
    name: 'Audittarget', reason: 'Approved global report', raid: 'Kazeros Hard',
    scope: 'global', guildId: '', addedByUserId: 'original-author', allCharacters: ['Audittarget'],
  });
  const actor = { id: 'unprivileged-member', username: 'Member', tag: 'member' };
  assert.equal(isRequesterAutoApprover(actor.id), false);

  const approvals = [];
  const executor = createListAddExecutor({ client: {}, broadcastListChange: async () => {} });
  const handleAdd = createListAddCommandHandler({
    client: {}, executeListAddToDatabase: executor,
    sendListAddApprovalToApprovers: async (_guild, sentPayload) => {
      approvals.push(sentPayload);
      return { success: true, deliveredApproverIds: ['approver'], deliveredDmMessages: [] };
    },
  });
  const edits = [];
  const values = { type: 'black', name: 'Audittarget', reason: 'Unapproved replacement', raid: 'Kazeros Hard', scope: 'server' };
  const interaction = {
    user: actor, guild: { id: 'member-guild', name: 'Member guild' }, guildId: 'member-guild', channelId: 'channel',
    options: { getString: key => values[key] ?? null, getAttachment: () => null },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async replyPayload => { edits.push(replyPayload); return { id: 'request-message' }; },
    fetchReply: async () => ({ id: 'request-message' }),
  };
  await handleAdd(interaction);

  const customIds = edits.flatMap(edit => edit.components || []).flatMap(row => row.toJSON().components).map(button => button.custom_id);
  assert.equal(customIds.some(id => id.startsWith('listnote_add:')), false, 'the member gets no note button on a global entry');
  assert.equal(approvals.length, 1);
  const pending = await PendingApproval.findOne({ requestId: approvals[0].requestId }).lean();
  assert.ok(pending, 'the request waits for an approver');
  assert.equal(pending.requestMessageId, 'request-message');
  const stored = await Blacklist.findById(original._id).lean();
  assert.equal(stored.reason, 'Approved global report');
  assert.equal(stored.notes.length, original.notes.length);
});
