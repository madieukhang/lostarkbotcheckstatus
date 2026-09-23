import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = 'senior-1';
process.env.OFFICER_APPROVER_IDS = '';

const { default: mongoose } = await import('mongoose');
const { default: PendingApproval } = await import('../bot/models/PendingApproval.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { disconnectDB } = await import('../bot/db.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { createMultiaddConfirmButtonHandler } = await import('../bot/handlers/list/multiadd/confirmButton.js');

// The first acknowledgement fails once the slow work has started, the way
// Discord's 3-second window does for a click answered too late.
function makeConfirmInteraction(events, { failFinalEdit = false } = {}) {
  let acknowledged = false;
  const acknowledge = async () => {
    if (events.includes('create')) throw new Error('Unknown interaction');
    acknowledged = true;
    events.push('ack');
  };
  return {
    customId: 'multiadd_confirm:req-1',
    user: { id: 'member-1', tag: 'Member#0001' },
    guild: { id: 'guild-1' },
    update: acknowledge,
    editReply: async (payload) => {
      if (!acknowledged) throw new Error('Interaction has not been acknowledged');
      if (failFinalEdit) throw new Error('Unknown Webhook');
      events.push({ edit: payload });
    },
  };
}

function createHandler(t, events) {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => {
    clearUserLanguageCache();
    await disconnectDB();
  });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(PendingApproval, 'create', async () => { events.push('create'); });
  t.mock.method(PendingApproval, 'updateOne', async () => { events.push('record'); });
  t.mock.method(PendingApproval, 'deleteOne', async () => { events.push('delete'); });

  const pending = new Map([['req-1', {
    requesterId: 'member-1',
    requesterTag: 'Member#0001',
    requesterDisplayName: 'Member',
    guildId: 'guild-1',
    channelId: 'channel-1',
    rows: [{ name: 'Alpha', type: 'black', reason: 'Report' }],
  }]]);
  return createMultiaddConfirmButtonHandler({
    client: {},
    multiaddPending: pending,
    clearMultiaddPending: (id) => pending.delete(id),
    sendBulkApprovalToApprovers: async () => {
      events.push('dm');
      return { success: true, deliveredApproverIds: ['senior-1'], deliveredDmMessages: [] };
    },
    broadcastBulkAdd: async () => assert.fail('A member batch must wait for approval'),
    executeBulkMultiadd: async () => assert.fail('A member batch must wait for approval'),
    buildBulkSummaryEmbed: () => assert.fail('A member batch must wait for approval'),
  });
}

test('member multiadd confirm acknowledges before creating the approval request', async (t) => {
  const events = [];
  const handler = createHandler(t, events);
  await handler(makeConfirmInteraction(events));

  const ackAt = events.indexOf('ack');
  assert.ok(ackAt >= 0 && ackAt < events.indexOf('create'), `events: ${JSON.stringify(events)}`);
  assert.ok(!events.includes('delete'));
  assert.match(events.at(-1).edit.embeds[0].toJSON().title, /Waiting for Senior approval/);
});

test('member multiadd confirm keeps the sent approval when only the last edit fails', async (t) => {
  const events = [];
  const handler = createHandler(t, events);
  await handler(makeConfirmInteraction(events, { failFinalEdit: true }));

  assert.ok(events.includes('dm'));
  assert.ok(!events.includes('delete'), `events: ${JSON.stringify(events)}`);
});
