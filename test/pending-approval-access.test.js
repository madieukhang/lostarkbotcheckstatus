import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PENDING_APPROVAL_ACCESS,
  resolvePendingApprovalAccess,
} from '../bot/handlers/list/services/pendingApprovalAccess.js';

function makePendingApprovalStub({ payload = null, exists = false } = {}) {
  const calls = {
    findOne: [],
    findOneAndDelete: [],
    exists: [],
  };
  const query = () => ({ lean: async () => payload });
  return {
    calls,
    findOne(filter) {
      calls.findOne.push(filter);
      return query();
    },
    findOneAndDelete(filter) {
      calls.findOneAndDelete.push(filter);
      return query();
    },
    async exists(filter) {
      calls.exists.push(filter);
      return exists;
    },
  };
}

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

test('pending approval access consumes bulk requests and reports expiry', async () => {
  const PendingApprovalModel = makePendingApprovalStub();

  const result = await resolvePendingApprovalAccess({
    PendingApprovalModel,
    requestId: 'req-3',
    approverId: 'user-3',
    filters: { action: 'bulk' },
    consume: true,
  });

  assert.deepEqual(result, {
    status: PENDING_APPROVAL_ACCESS.expired,
    payload: null,
  });
  assert.equal(PendingApprovalModel.calls.findOne.length, 0);
  assert.deepEqual(PendingApprovalModel.calls.findOneAndDelete[0], {
    action: 'bulk',
    requestId: 'req-3',
    approverIds: 'user-3',
  });
});
