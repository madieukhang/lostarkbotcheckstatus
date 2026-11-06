import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_APPROVAL_ACCESS,
  resolvePendingApprovalAccess,
  claimApproval,
} from '../bot/handlers/list/services/pendingApprovalAccess.js';

function makePendingApprovalStub({ payload = null, exists = false } = {}) {
  const calls = {
    findOne: [],
    exists: [],
  };
  const query = () => ({ lean: async () => payload });
  return {
    calls,
    findOne(filter) {
      calls.findOne.push(filter);
      return query();
    },
    async exists(filter) {
      calls.exists.push(filter);
      return exists;
    },
  };
}

test('approval claim authorizes atomically without a redundant payload read', async () => {
  const result = await claimApproval({
    interaction: { customId: 'approve:req' },
    PendingApprovalModel: {
      findOne: () => assert.fail('successful claims do not need a separate read'),
      findOneAndUpdate: (filter, _update, options) => ({ lean: async () => {
        assert.equal(filter.approverIds, 'a');
        assert.equal(filter.requestId, 'req');
        assert.equal(filter.action, 'bulk');
        assert.ok(filter.$or);
        assert.deepEqual(filter.processingAction.$in, [null, '', 'approve']);
        assert.deepEqual(options, { returnDocument: 'after' });
        return { requestId: 'req' };
      } }),
      updateOne: async () => ({ matchedCount: 1 }),
    },
    requestId: 'req', approverId: 'a', filters: { action: 'bulk' }, renewIntervalMs: 0,
  });
  assert.equal(result.status, PENDING_APPROVAL_ACCESS.authorized);
  await result.claim.release();
});

test('a claim renewal also reads the renewed request with returnDocument, not the deprecated new option', async () => {
  const optionsSeen = [];
  const result = await claimApproval({
    interaction: { customId: 'approve:req' },
    PendingApprovalModel: {
      findOne: () => assert.fail('successful claims do not need a separate read'),
      findOneAndUpdate: (_filter, _update, options) => ({ lean: async () => {
        optionsSeen.push(options);
        return { requestId: 'req' };
      } }),
      updateOne: async () => ({ matchedCount: 1 }),
    },
    requestId: 'req', approverId: 'a', renewIntervalMs: 0,
  });
  await result.claim.assertOwned();
  await result.claim.release();
  assert.deepEqual(optionsSeen, [{ returnDocument: 'after' }, { returnDocument: 'after' }]);
});

test('pending approval access returns an authorized payload without probing existence', async () => {
  const payload = { requestId: 'req-1' };
  const PendingApprovalModel = makePendingApprovalStub({ payload });

  const result = await resolvePendingApprovalAccess({
    PendingApprovalModel,
    requestId: 'req-1',
    approverId: 'user-1',
    filters: { action: 'bulk' },
  });

  assert.deepEqual(result, {
    status: PENDING_APPROVAL_ACCESS.authorized,
    payload,
  });
  assert.deepEqual(PendingApprovalModel.calls.findOne[0], {
    action: 'bulk',
    requestId: 'req-1',
    approverIds: 'user-1',
  });
  assert.equal(PendingApprovalModel.calls.exists.length, 0);
});

test('pending approval access distinguishes another approver from expiry', async () => {
  const PendingApprovalModel = makePendingApprovalStub({ exists: true });

  const result = await resolvePendingApprovalAccess({
    PendingApprovalModel,
    requestId: 'req-2',
    approverId: 'user-2',
  });

  assert.deepEqual(result, {
    status: PENDING_APPROVAL_ACCESS.notAuthorized,
    payload: null,
  });
  assert.deepEqual(PendingApprovalModel.calls.exists[0], { requestId: 'req-2' });
});

test('pending approval access scopes bulk reads and reports expiry', async () => {
  const PendingApprovalModel = makePendingApprovalStub();

  const result = await resolvePendingApprovalAccess({
    PendingApprovalModel,
    requestId: 'req-3',
    approverId: 'user-3',
    filters: { action: 'bulk' },
  });

  assert.deepEqual(result, {
    status: PENDING_APPROVAL_ACCESS.expired,
    payload: null,
  });
  assert.deepEqual(PendingApprovalModel.calls.findOne[0], {
    action: 'bulk',
    requestId: 'req-3',
    approverIds: 'user-3',
  });
});
