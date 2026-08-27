import test from 'node:test';
import assert from 'node:assert/strict';

import { AlertSeverity } from '../bot/utils/alertEmbed.js';
import {
  buildListMutationPayload,
  persistDeliveredApproval,
  renderListAddExecutionResult,
  submitListMutation,
} from '../bot/handlers/list/services/mutationFlow.js';

test('buildListMutationPayload keeps canonical request and requester metadata', () => {
  const interaction = {
    guild: { id: 'guild-1' },
    channelId: 'channel-1',
    user: {
      id: 'user-1',
      tag: 'requester#0001',
      username: 'requester',
    },
  };

  const payload = buildListMutationPayload({
    requestId: 'request-1',
    interaction,
    requestedByDisplayName: 'Requester Display',
    lang: 'vi',
    createdAt: 12345,
    type: 'black',
    name: 'Testname',
    reason: 'Test reason',
    scope: 'global',
  });

  assert.deepEqual(payload, {
    requestId: 'request-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    type: 'black',
    name: 'Testname',
    reason: 'Test reason',
    scope: 'global',
    requestedByUserId: 'user-1',
    requestedByTag: 'requester#0001',
    requestedByName: 'requester',
    requestedByDisplayName: 'Requester Display',
    lang: 'vi',
    createdAt: 12345,
  });
});

test('buildListMutationPayload supports bulk metadata without adding an undefined language', () => {
  const payload = buildListMutationPayload({
    requestId: 'bulk-row-1',
    guildId: 'guild-1',
    channelId: 'channel-1',
    requester: {
      id: 'requester-1',
      tag: 'requester#0001',
      username: 'requester',
    },
    requestedByDisplayName: 'Requester Display',
    createdAt: 67890,
    type: 'white',
    name: 'Bulkname',
    skipBroadcast: true,
  });

  assert.equal(Object.hasOwn(payload, 'lang'), false);
  assert.equal(payload.requestedByUserId, 'requester-1');
  assert.equal(payload.requestedByTag, 'requester#0001');
  assert.equal(payload.requestedByName, 'requester');
  assert.equal(payload.requestedByDisplayName, 'Requester Display');
  assert.equal(payload.skipBroadcast, true);
});

test('persistDeliveredApproval stores only the recipients that received a DM', async () => {
  let createdPayload;
  const PendingApprovalModel = {
    create: async (payload) => {
      createdPayload = payload;
      return payload;
    },
  };
  const payload = { requestId: 'request-1', name: 'Testname' };
  const delivery = {
    deliveredApproverIds: ['approver-1'],
    deliveredDmMessages: [{
      approverId: 'approver-1',
      channelId: 'dm-1',
      messageId: 'message-1',
    }],
  };

  await persistDeliveredApproval(PendingApprovalModel, payload, delivery);

  assert.deepEqual(createdPayload, {
    ...payload,
    approverIds: delivery.deliveredApproverIds,
    approverDmMessages: delivery.deliveredDmMessages,
  });
});

test('renderListAddExecutionResult preserves rich-embed and notice projections', async () => {
  const calls = [];
  const interaction = { id: 'interaction-1' };
  const deps = {
    editEmbedFn: async (...args) => calls.push({ kind: 'embed', args }),
    editNoticeFn: async (...args) => calls.push({ kind: 'notice', args }),
  };

  await renderListAddExecutionResult(
    interaction,
    { ok: true, embeds: [{ title: 'Added' }], components: [{ id: 'enrich' }] },
    'vi',
    deps,
  );
  await renderListAddExecutionResult(
    interaction,
    { ok: false, content: 'Skipped', components: [{ id: 'retry' }] },
    'vi',
    deps,
  );

  assert.deepEqual(calls[0], {
    kind: 'embed',
    args: [
      interaction,
      [{ title: 'Added' }],
      { content: null, components: [{ id: 'enrich' }] },
    ],
  });
  assert.deepEqual(calls[1], {
    kind: 'notice',
    args: [
      interaction,
      'Skipped',
      {
        severity: AlertSeverity.WARNING,
        lang: 'vi',
        components: [{ id: 'retry' }],
      },
    ],
  });
});

function buildSubmissionDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    options: {
      interaction: { guild: { id: 'guild-1' } },
      payload: {
        requestedByUserId: 'requester-1',
        requestId: 'request-1',
        scope: 'global',
      },
      lang: 'vi',
      PendingApprovalModel: {
        create: async (payload) => calls.push(['persist', payload]),
      },
      sendListAddApprovalToApprovers: async () => ({
        success: true,
        deliveredApproverIds: ['approver-1'],
        deliveredDmMessages: [],
      }),
      executeListAddToDatabase: async () => ({ ok: true }),
      connectDBFn: async () => calls.push(['connect']),
      isRequesterAutoApproverFn: () => false,
      renderExecutionResultFn: async (...args) => calls.push(['render', ...args]),
      onDeliveryFailed: async (delivery) => calls.push(['delivery-failed', delivery]),
      onQueued: async (delivery) => calls.push(['queued', delivery]),
      ...overrides,
    },
  };
}

test('submitListMutation executes officers and server-scoped requests immediately', async () => {
  for (const overrides of [
    { isRequesterAutoApproverFn: () => true },
    { payload: { requestedByUserId: 'requester-1', requestId: 'request-1', scope: 'server' } },
  ]) {
    const { calls, options } = buildSubmissionDeps(overrides);
    const result = await submitListMutation(options);
    assert.equal(result.status, 'executed');
    assert.deepEqual(calls.map(([kind]) => kind), ['render']);
  }
});

test('submitListMutation persists only after a successful approval delivery', async () => {
  const { calls, options } = buildSubmissionDeps();
  const result = await submitListMutation(options);

  assert.equal(result.status, 'queued');
  assert.deepEqual(calls.map(([kind]) => kind), ['connect', 'persist', 'queued']);
});

test('submitListMutation stops before persistence when approval delivery fails', async () => {
  const delivery = { success: false, reason: 'no approver accepted the DM' };
  const { calls, options } = buildSubmissionDeps({
    sendListAddApprovalToApprovers: async () => delivery,
  });
  const result = await submitListMutation(options);

  assert.equal(result.status, 'delivery-failed');
  assert.deepEqual(calls, [['delivery-failed', delivery]]);
});
