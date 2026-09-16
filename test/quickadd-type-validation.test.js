import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { disconnectDB } = await import('../bot/db.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { COLORS } = await import('../bot/utils/ui.js');
const { createQuickAddHandlers } = await import('../bot/handlers/list/quickadd/index.js');

function stubEnglishViewer(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

function recordingServices(calls) {
  return {
    sendListAddApprovalToApprovers: async (_guild, payload) => {
      calls.push(['approval', payload.type]);
      return { success: false, reason: 'No approver available' };
    },
    executeListAddToDatabase: async (payload) => {
      calls.push(['write', payload.type]);
      return { ok: true };
    },
  };
}

function modalSubmit(typedType, replies) {
  const values = { quickadd_type: typedType, quickadd_reason: 'Left mid-raid', quickadd_raid: '' };
  return {
    customId: 'quickadd_modal:Mokoko',
    fields: { getTextInputValue: (id) => values[id] },
    user: { id: 'requester-1', tag: 'requester#0001', username: 'requester' },
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
}

test('quick add rejects an unknown list type instead of filing it as blacklist', async (t) => {
  stubEnglishViewer(t);
  const calls = [];
  const replies = [];
  const { handleQuickAddModal } = createQuickAddHandlers({ services: recordingServices(calls) });

  await handleQuickAddModal(modalSubmit('watchlist', replies));

  assert.deepEqual(calls, []);
  assert.equal(replies.length, 1);
  const embed = replies[0].embeds[0].toJSON();
  assert.equal(embed.color, COLORS.danger);
  assert.match(embed.title, /That is not a list type/);
  assert.match(embed.description, /`watchlist`/);
});

test('quick add submits a valid type after trimming and lowercasing it', async (t) => {
  stubEnglishViewer(t);
  const calls = [];
  const { handleQuickAddModal } = createQuickAddHandlers({ services: recordingServices(calls) });

  await handleQuickAddModal(modalSubmit(' Watch ', []));

  assert.deepEqual(calls, [['approval', 'watch']]);
});
