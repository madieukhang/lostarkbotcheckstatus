import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import PendingApproval from '../bot/models/PendingApproval.js';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import { acknowledgeAndClaimApproval, runClaimedApproval } from '../bot/handlers/list/services/pendingApprovalAccess.js';
import { moveListEntry } from '../bot/handlers/list/services/moveEntry.js';
import { applyListEditNow } from '../bot/handlers/list/edit/applyNow.js';
import { handleApprovedEditRequest } from '../bot/handlers/list/add/editApproval.js';

let mongo;
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([PendingApproval.init(), Blacklist.init(), Whitelist.init()]);
});
test.after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test.beforeEach(async () => {
  await Promise.all([PendingApproval.deleteMany({}), Blacklist.deleteMany({}), Whitelist.deleteMany({})]);
});

async function seedRequest() {
  await PendingApproval.create({ requestId: 'request', guildId: 'guild', channelId: 'channel', type: 'black', name: 'Example', requestedByUserId: 'requester', approverIds: ['a', 'b'] });
}
function acquire(action = 'approve', now = Date.now(), approverId = 'a', overrides = {}) {
  return acknowledgeAndClaimApproval({
    PendingApprovalModel: PendingApproval, requestId: 'request', approverId,
    now: () => now, leaseMs: 1000, renewIntervalMs: 0,
    interaction: { customId: `listadd_${action}:request`, deferUpdate: async () => {} },
    ...overrides,
  });
}

test('an interrupted approval survives reconnect and can resume after its lease expires', async () => {
  await seedRequest();
  const now = Date.now();
  const first = await acquire('approve', now);
  assert.ok(first.payload);
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri());
  assert.ok(await PendingApproval.findOne({ requestId: 'request' }));
  const resumed = await acquire('approve', now + 1001);
  assert.ok(resumed.payload);
  await resumed.claim.complete();
  assert.equal(await PendingApproval.countDocuments({}), 0);
});

for (const secondAction of ['approve', 'reject']) {
  test(`Mongo grants only one simultaneous approve/${secondAction} claim`, async () => {
    await seedRequest();
    const now = Date.now();
    const claims = await Promise.all([acquire('approve', now), acquire(secondAction, now, 'b')]);
    assert.equal(claims.filter(item => item.payload).length, 1);
    assert.equal(claims.filter(item => item.status === 'processing').length, 1);
    await claims.find(item => item.payload).claim.complete();
  });
}

test('recovery cannot reverse an already-started decision or use an old claim to remove its successor', async () => {
  await seedRequest();
  const now = Date.now();
  const first = await acquire('approve', now);
  assert.equal((await acquire('reject', now + 1001, 'b')).status, 'processing');
  const resumed = await acquire('approve', now + 1001, 'b');
  await assert.rejects(first.claim.assertOwned(), { code: 'APPROVAL_LEASE_LOST' });
  await assert.rejects(first.claim.complete(), { code: 'APPROVAL_LEASE_LOST' });
  await assert.rejects(first.claim.release({ duplicateEntryId: 'wrong' }, { clearDecision: true }), { code: 'APPROVAL_LEASE_LOST' });
  const current = await PendingApproval.findOne({ requestId: 'request' }).lean();
  assert.equal(current.processingToken, resumed.payload.processingToken);
  assert.notEqual(current.duplicateEntryId, 'wrong');
  await resumed.claim.complete();
});

test('a failed operation releases the lease for the same decision without deleting its request', async () => {
  await seedRequest();
  const first = await acquire();
  await assert.rejects(runClaimedApproval(first.claim, async () => { throw new Error('Transient failure'); }), /Transient failure/);
  const current = await PendingApproval.findOne({ requestId: 'request' }).lean();
  assert.equal(current.processingAction, 'listadd_approve');
  assert.equal(current.processingToken, undefined);
  const resumed = await acquire();
  assert.ok(resumed.payload);
  await resumed.claim.complete();
});

test('duplicate detection releases the original decision for the overwrite or keep phase', async () => {
  await seedRequest();
  const first = await acquire();
  await first.claim.release({ duplicateEntryId: 'original' }, { clearDecision: true });
  const next = await acquire('overwrite');
  assert.equal(next.payload.duplicateEntryId, 'original');
  await next.claim.complete();
});

test('failed acknowledgement never claims or deletes the request', async () => {
  await seedRequest();
  await assert.rejects(acquire('approve', Date.now(), 'a', {
    interaction: { customId: 'listadd_approve:request', deferUpdate: async () => { throw new Error('Unknown interaction'); } },
  }), /Unknown interaction/);
  const current = await PendingApproval.findOne({ requestId: 'request' }).lean();
  assert.equal(current.processingAction, '');
  assert.equal(current.processingToken, '');
});

async function seedSource() {
  return Whitelist.create({ name: 'Example', reason: 'Original reason', addedByUserId: 'owner', allCharacters: ['Example'] });
}
function move(existing) {
  return moveListEntry({
    oldModel: Whitelist, newModel: Blacklist, existing,
    buildData: source => ({ name: source.name, allCharacters: source.allCharacters, reason: 'Moved reason', scope: 'global' }),
  });
}

test('a committed list move creates the destination and removes the source together', async () => {
  const moved = await move(await seedSource());
  assert.equal(moved.reason, 'Moved reason');
  assert.equal(await Whitelist.countDocuments({}), 0);
  assert.equal(await Blacklist.countDocuments({}), 1);
});

for (const surface of ['immediate', 'approved']) {
  test(`${surface} edit uses the transactional move and renders only its committed result`, async () => {
    const existing = await seedSource();
    const cards = [];
    const interaction = { user: { id: 'owner', tag: 'Owner' }, guild: { id: 'guild' }, message: { id: 'dm' }, editReply: async payload => cards.push(payload) };
    if (surface === 'immediate') {
      await applyListEditNow({
        interaction, client: {}, existing, currentType: 'white', targetType: 'black', isTypeChange: true,
        targetScope: 'global', newScope: 'global', additionalNamesParsed: { added: [] },
        changes: ['Move'], isOwner: true, editGuildId: 'guild', editGuildDefaultScope: 'global',
      });
    } else {
      let closed = false;
      await handleApprovedEditRequest({
        interaction, payload: { currentType: 'white', type: 'black', existingEntryId: String(existing._id), scope: 'global', guildId: 'guild' },
        requestId: 'request', completeApproval: async () => { closed = true; },
        syncApproverDmMessages: async () => {}, broadcastListChange: async () => {}, notifyRequesterAboutDecision: async () => {},
      });
      assert.equal(closed, true);
    }
    assert.equal(await Whitelist.countDocuments({}), 0);
    assert.equal(await Blacklist.countDocuments({}), 1);
    assert.ok(cards.length > 0);
  });
}

test('source-delete failure rolls back the newly-created destination', async t => {
  const existing = await seedSource();
  t.mock.method(Whitelist, 'deleteOne', async () => { throw new Error('Source delete failed'); });
  await assert.rejects(move(existing), /Source delete failed/);
  assert.equal(await Whitelist.countDocuments({}), 1);
  assert.equal(await Blacklist.countDocuments({}), 0);
});

test('approval interrupted after move commit recognizes the destination on retry', async () => {
  const source = await seedSource();
  let completed = false;
  const args = {
    interaction: { user: { id: 'officer' }, message: { id: 'dm' }, editReply: async () => {} },
    payload: { name: source.name, currentType: 'white', type: 'black', existingEntryId: String(source._id), scope: 'global', guildId: 'guild' },
    requestId: 'request', syncApproverDmMessages: async () => {}, broadcastListChange: async () => {}, notifyRequesterAboutDecision: async () => {},
  };
  await assert.rejects(handleApprovedEditRequest({ ...args, completeApproval: async () => { throw new Error('Interrupted after commit'); } }), /Interrupted after commit/);
  assert.equal(await Whitelist.countDocuments({}), 0);
  assert.equal((await Blacklist.findById(source._id)).name, source.name);
  await handleApprovedEditRequest({ ...args, completeApproval: async () => { completed = true; } });
  assert.equal(completed, true);
  assert.equal(await Blacklist.countDocuments({}), 1);
});

test('destination unique-key failure preserves the source and the existing destination', async () => {
  const existing = await seedSource();
  await Blacklist.create({ name: 'Example', reason: 'Existing target' });
  await assert.rejects(move(existing), error => error.code === 11000);
  assert.equal(await Whitelist.countDocuments({}), 1);
  assert.equal((await Blacklist.findOne({ name: 'Example' })).reason, 'Existing target');
});

test('a concurrent ownership change aborts the transaction instead of deleting the new owner entry', async t => {
  const existing = await seedSource();
  const originalDelete = Whitelist.deleteOne;
  let injected = false;
  t.mock.method(Whitelist, 'deleteOne', async function (...args) {
    if (!injected) {
      injected = true;
      await Whitelist.collection.updateOne({ _id: existing._id }, { $set: { addedByUserId: 'new-owner' } });
    }
    return originalDelete.apply(this, args);
  });
  await assert.rejects(move(existing), /ownership or scope changed/);
  assert.equal((await Whitelist.findById(existing._id)).addedByUserId, 'new-owner');
  assert.equal(await Blacklist.countDocuments({}), 0);
});
