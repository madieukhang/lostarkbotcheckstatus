import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';
process.env.OFFICER_APPROVER_IDS = 'officer-1';

const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { disconnectDB } = await import('../bot/db.js');
const { clearUserLanguageCache, t: translate } = await import('../bot/services/i18n/index.js');
const { applyListEditNow } = await import('../bot/handlers/list/edit/applyNow.js');
const { createListAddCommandHandler } = await import('../bot/handlers/list/add/command.js');
const { createQuickAddHandlers } = await import('../bot/handlers/list/quickadd/index.js');
const { submitListMutation } = await import('../bot/handlers/list/services/mutationFlow.js');

// The first reply, the success card, is rejected. The only later reply this
// suite expects is the notice that the write was saved; it is rejected too
// when `rejectAll` is set.
function replyRecorder({ rejectAll = false } = {}) {
  const attempts = [];
  return {
    attempts,
    editReply: async (payload) => {
      attempts.push(payload);
      if (rejectAll || attempts.length === 1) throw new Error('Discord edit failed');
      return {};
    },
  };
}

function assertNotice(payload, key) {
  assert.ok(payload.embeds[0].toJSON().title.includes(translate(key, 'en')), key);
}

function stubEnglishViewer(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

for (const [isMove, noticeRejected] of [[false, false], [true, false], [false, true], [true, true]]) {
  test(`a failed edit success card after the write still broadcasts and gets the saved notice (${isMove ? 'move' : 'in-place'}, notice ${noticeRejected ? 'rejected' : 'delivered'})`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const existing = {
      _id: 'c'.repeat(24), name: 'Tenshi', reason: 'Reason', allCharacters: [], addedByUserId: 'owner',
    };
    const currentType = isMove ? 'white' : 'black';
    if (isMove) {
      t.mock.method(Blacklist, 'findOne', () => ({ collation() { return this; }, lean: async () => null }));
      t.mock.method(Whitelist.db, 'transaction', async (run) => run('session'));
      t.mock.method(Whitelist, 'findById', () => ({ session: async () => existing }));
      t.mock.method(Blacklist, 'create', async ([entry]) => [entry]);
      t.mock.method(Whitelist, 'deleteOne', async () => ({ deletedCount: 1 }));
    } else {
      t.mock.method(Blacklist, 'updateOne', async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }));
    }
    t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
    const { attempts, editReply } = replyRecorder({ rejectAll: noticeRejected });
    const broadcasts = [];

    await applyListEditNow({
      existing, currentType, targetType: 'black', isTypeChange: isMove, targetScope: 'global',
      newReason: 'New reason', additionalNamesParsed: { added: [] }, isOwner: false,
      broadcastListChange: async (...args) => { broadcasts.push(args); },
      interaction: {
        guild: { id: 'guild' },
        user: { id: 'officer', username: 'Officer', tag: 'Officer#0001' },
        editReply,
      },
      client: {}, editGuildId: 'guild', editGuildDefaultScope: 'global', lang: 'en',
    });

    assert.equal(attempts.length, 2, 'only the saved notice follows the rejected success card');
    assertNotice(attempts[1], 'dialogue.common.savedCardFailed');
    assert.equal(broadcasts.length, 1);
  });
}

test('a failed success card after an auto-approved add is not reported as a failed proposal', async (t) => {
  stubEnglishViewer(t);
  const { attempts, editReply } = replyRecorder();
  const writes = [];
  const handleListAddCommand = createListAddCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: async () => assert.fail('an officer add is written at once'),
    executeListAddToDatabase: async (payload) => { writes.push(payload.name); return { ok: true, content: 'Added' }; },
  });

  await handleListAddCommand({
    user: { id: 'officer-1', username: 'Officer', tag: 'Officer#0001' },
    guild: { id: 'guild' },
    channelId: 'channel',
    options: {
      getString: (key) => ({ type: 'black', name: 'Mokoko', reason: 'Left mid-raid', scope: 'server' })[key] ?? null,
      getAttachment: () => null,
    },
    deferReply: async () => {},
    editReply,
  });

  assert.deepEqual(writes, ['Mokoko']);
  assert.equal(attempts.length, 2, 'only the saved notice follows the rejected success card');
  assertNotice(attempts[1], 'dialogue.common.savedCardFailed');
});

test('a rejected saved notice after an auto-approved add is swallowed', async (t) => {
  stubEnglishViewer(t);
  const { attempts, editReply } = replyRecorder({ rejectAll: true });
  const writes = [];
  const handleListAddCommand = createListAddCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: async () => assert.fail('an officer add is written at once'),
    executeListAddToDatabase: async (payload) => { writes.push(payload.name); return { ok: true, content: 'Added' }; },
  });

  await handleListAddCommand({
    user: { id: 'officer-1', username: 'Officer', tag: 'Officer#0001' },
    guild: { id: 'guild' },
    channelId: 'channel',
    options: {
      getString: (key) => ({ type: 'black', name: 'Mokoko', reason: 'Left mid-raid', scope: 'server' })[key] ?? null,
      getAttachment: () => null,
    },
    deferReply: async () => {},
    editReply,
  });

  assert.deepEqual(writes, ['Mokoko']);
  assert.equal(attempts.length, 2, 'the saved notice was tried once and its failure ended the handler quietly');
});

test('a failed success card after an auto-approved quick add is not reported as a failure', async (t) => {
  stubEnglishViewer(t);
  const { attempts, editReply } = replyRecorder();
  const writes = [];
  const { handleQuickAddModal } = createQuickAddHandlers({ services: {
    sendListAddApprovalToApprovers: async () => assert.fail('an officer add is written at once'),
    executeListAddToDatabase: async (payload) => { writes.push(payload.name); return { ok: true, content: 'Added' }; },
  } });
  const values = { quickadd_type: 'white', quickadd_reason: 'Reliable', quickadd_raid: '' };

  await handleQuickAddModal({
    customId: 'quickadd_modal:Mokoko',
    fields: { getTextInputValue: (id) => values[id] },
    user: { id: 'officer-1', tag: 'Officer#0001', username: 'Officer' },
    deferReply: async () => {},
    editReply,
  });

  assert.deepEqual(writes, ['Mokoko']);
  assert.equal(attempts.length, 2, 'only the saved notice follows the rejected success card');
  assertNotice(attempts[1], 'dialogue.common.savedCardFailed');
});

test('submitListMutation keeps a failed render of a written add from throwing but not a failed render of a refusal', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const submit = (result) => submitListMutation({
    interaction: { guild: { id: 'guild' } },
    payload: { requestedByUserId: 'officer-1', scope: 'global', requestId: 'r' },
    lang: 'en',
    executeListAddToDatabase: async () => result,
    sendListAddApprovalToApprovers: async () => assert.fail('no approval round trip'),
    isRequesterAutoApproverFn: () => true,
    renderExecutionResultFn: async () => { throw new Error('Discord edit failed'); },
  });

  assert.deepEqual(await submit({ ok: true }), { status: 'executed', result: { ok: true } });
  await assert.rejects(submit({ ok: false, content: 'Refused' }), /Discord edit failed/);
});

test('a failed queued card after the pending request is saved is not reported as a failed proposal (add)', async (t) => {
  stubEnglishViewer(t);
  const { default: PendingApproval } = await import('../bot/models/PendingApproval.js');
  const saved = [];
  t.mock.method(PendingApproval, 'create', async (doc) => { saved.push(doc); return doc; });
  t.mock.method(PendingApproval, 'updateOne', async () => ({}));
  const { attempts, editReply } = replyRecorder();
  const handleListAddCommand = createListAddCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: async () => ({ success: true, deliveredApproverIds: ['senior'], deliveredDmMessages: [] }),
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
    editReply,
  });

  assert.equal(saved.length, 1);
  assert.equal(attempts.length, 2, 'only the queued notice follows the rejected queued card');
  assertNotice(attempts[1], 'dialogue.common.queuedCardFailed');
});

test('a failed queued card after the pending request is saved is not reported as a failure (quick add)', async (t) => {
  stubEnglishViewer(t);
  const { default: PendingApproval } = await import('../bot/models/PendingApproval.js');
  const saved = [];
  t.mock.method(PendingApproval, 'create', async (doc) => { saved.push(doc); return doc; });
  const { attempts, editReply } = replyRecorder();
  const { handleQuickAddModal } = createQuickAddHandlers({ services: {
    sendListAddApprovalToApprovers: async () => ({ success: true, deliveredApproverIds: ['senior'], deliveredDmMessages: [] }),
    executeListAddToDatabase: async () => assert.fail('a member add waits for an approver'),
  } });
  const values = { quickadd_type: 'white', quickadd_reason: 'Reliable', quickadd_raid: '' };

  await handleQuickAddModal({
    customId: 'quickadd_modal:Mokoko',
    fields: { getTextInputValue: (id) => values[id] },
    user: { id: 'member-1', tag: 'Member#0001', username: 'Member' },
    guild: { id: 'guild', name: 'Guild' },
    deferReply: async () => {},
    editReply,
  });

  assert.equal(saved.length, 1);
  assert.equal(attempts.length, 2, 'only the queued notice follows the rejected queued card');
  assertNotice(attempts[1], 'dialogue.common.queuedCardFailed');
});

test('submitListMutation keeps a queued request queued when its card fails, but not when nothing was saved', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const saved = [];
  const noticeAttempts = [];
  const submit = (PendingApprovalModel) => submitListMutation({
    interaction: {
      guild: { id: 'guild' },
      editReply: async (payload) => { noticeAttempts.push(payload); throw new Error('Discord edit failed'); },
    },
    payload: { requestedByUserId: 'member-1', scope: 'global', requestId: 'r' },
    lang: 'en',
    PendingApprovalModel,
    executeListAddToDatabase: async () => assert.fail('a member add waits for an approver'),
    sendListAddApprovalToApprovers: async () => ({ success: true, deliveredApproverIds: ['senior'], deliveredDmMessages: [] }),
    connectDBFn: async () => {},
    isRequesterAutoApproverFn: () => false,
    onQueued: async () => { throw new Error('Discord edit failed'); },
  });

  const queued = await submit({ create: async (doc) => { saved.push(doc); return doc; } });
  assert.equal(queued.status, 'queued');
  assert.equal(saved.length, 1);
  assert.equal(noticeAttempts.length, 1, 'the queued notice is tried once and its failure is swallowed');
  assertNotice(noticeAttempts[0], 'dialogue.common.queuedCardFailed');
  await assert.rejects(submit({ create: async () => { throw new Error('Mongo write failed'); } }), /Mongo write failed/);
});
