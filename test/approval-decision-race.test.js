import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { EmbedBuilder } from 'discord.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import UserPreference from '../bot/models/UserPreference.js';
import { createListAddApprovalButtonHandler } from '../bot/handlers/list/add/approvalButton.js';
import { createListAddOverwriteButtonHandler } from '../bot/handlers/list/add/overwriteButton.js';
import { createMultiaddApprovalButtonHandler } from '../bot/handlers/list/multiadd/approvalButton.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { disconnectDB } from '../bot/db.js';

function stubPending(t, overrides = {}) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  let pending = { requestId: 'race', name: 'Char', type: 'black', approverIds: ['a', 'b'], ...overrides };
  t.mock.method(PendingApproval, 'findOne', filter => ({ lean: async () =>
    pending?.approverIds.includes(filter.approverIds) ? { ...pending } : null,
  }));
  t.mock.method(PendingApproval, 'findOneAndDelete', filter => ({ lean: async () => {
    if (!pending?.approverIds.includes(filter.approverIds)) return null;
    const payload = pending;
    pending = null;
    return payload;
  } }));
  t.mock.method(PendingApproval, 'exists', async () => Boolean(pending));
  t.mock.method(PendingApproval, 'deleteOne', async () => { pending = null; });
  t.mock.method(PendingApproval, 'create', async payload => { assert.equal(pending, null); pending = payload; return payload; });
  return () => pending;
}

for (const secondAction of ['reject', 'approve']) {
  test(`concurrent approve/${secondAction} produces one decision and at most one write`, async t => {
    const getPending = stubPending(t);
    const outcomes = [];
    let acknowledgements = 0;
    let release;
    const acknowledged = new Promise(resolve => { release = resolve; });
    const handler = createListAddApprovalButtonHandler({
      executeListAddToDatabase: async () => { outcomes.push('write'); return { ok: true }; },
      syncApproverDmMessages: async () => {},
      notifyRequesterAboutDecision: async (_payload, _result, rejected) => { outcomes.push(rejected ? 'rejected' : 'approved'); },
    });
    const click = (id, action) => ({
      customId: `listadd_${action}:race`, user: { id, tag: id }, message: { id },
      deferUpdate: async () => { if (++acknowledgements === 2) release(); await acknowledged; },
      editReply: async () => {}, reply: async () => {}, followUp: async () => {},
    });
    await Promise.all([handler(click('a', 'approve')), handler(click('b', secondAction))]);
    assert.equal(outcomes.filter(value => value === 'approved' || value === 'rejected').length, 1);
    assert.ok(outcomes.filter(value => value === 'write').length <= 1);
    assert.ok(!(outcomes.includes('rejected') && outcomes.includes('write')));
    assert.equal(getPending(), null);
  });
}

for (const [customId, factory, action] of [
  ['listadd_approve:race', createListAddApprovalButtonHandler, 'add'],
  ['listadd_keep:race', createListAddOverwriteButtonHandler, 'add'],
  ['multiaddapprove_approve:race', createMultiaddApprovalButtonHandler, 'bulk'],
]) {
  test(`${customId} preserves the request if Discord acknowledgement fails`, async t => {
    const getPending = stubPending(t, { action });
    await assert.rejects(factory({})({
      customId, user: { id: 'a' },
      deferUpdate: async () => { throw new Error('Unknown interaction'); },
    }), /Unknown interaction/);
    assert.ok(getPending());
  });
}

test('failure to show processing restores an unexecuted approval request', async t => {
  const getPending = stubPending(t);
  const handler = createListAddApprovalButtonHandler({
    executeListAddToDatabase: () => assert.fail('Rendering failed before execution'),
  });
  await assert.rejects(handler({
    customId: 'listadd_approve:race', user: { id: 'a' }, message: { id: 'dm' },
    deferUpdate: async () => {}, editReply: async () => { throw new Error('Render failed'); },
  }), /Render failed/);
  assert.ok(getPending());
});

test('bulk approval acknowledges once, executes, and edits its final card', async t => {
  const getPending = stubPending(t, {
    action: 'bulk', guildId: 'bulk-guild', channelId: 'bulk-channel', requestedByUserId: 'requester',
    bulkRows: [{ name: 'Char', type: 'black', reason: 'Report', scope: 'global' }],
  });
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const events = [];
  const handler = createMultiaddApprovalButtonHandler({
    client: { guilds: { fetch: async () => ({ id: 'bulk-guild', channels: { fetch: async () => ({
      isTextBased: () => true, send: async () => events.push('notify'),
    }) } }) } },
    executeBulkMultiadd: async rows => {
      assert.deepEqual(events, ['ack', 'edit']);
      assert.equal(rows[0].name, 'Char');
      events.push('write');
      return { added: rows };
    },
    broadcastBulkAdd: async () => events.push('broadcast'),
    buildBulkSummaryEmbed: () => new EmbedBuilder().setTitle('Summary'),
    syncApproverDmMessages: async () => events.push('dm-sync'),
  });
  await handler({
    customId: 'multiaddapprove_approve:race', user: { id: 'a' }, message: { id: 'dm' },
    deferUpdate: async () => events.push('ack'), editReply: async () => events.push('edit'),
    update: () => assert.fail('A deferred interaction must not be acknowledged twice'),
  });
  assert.equal(getPending(), null);
  assert.deepEqual(events, ['ack', 'edit', 'write', 'broadcast', 'edit', 'dm-sync', 'notify']);
});
