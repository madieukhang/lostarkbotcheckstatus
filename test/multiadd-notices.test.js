import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = '';
process.env.OFFICER_APPROVER_IDS = 'officer-1';

const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { createMultiaddConfirmButtonHandler } = await import('../bot/handlers/list/multiadd/confirmButton.js');
const { COLORS, buildProgressBar } = await import('../bot/utils/ui.js');

const ROWS = Array.from({ length: 10 }, (_, index) => ({ name: `Name${index}`, type: 'black', reason: 'Report' }));

function setup(t, { pendingRows = ROWS, onExecute } = {}) {
  clearUserLanguageCache();
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'vi' }) }));
  t.after(() => clearUserLanguageCache());
  const pending = new Map(pendingRows ? [['req-1', {
    requesterId: 'officer-1',
    requesterTag: 'Officer#0001',
    requesterDisplayName: 'Officer',
    guildId: 'guild-1',
    channelId: 'channel-1',
    rows: pendingRows,
  }]] : []);
  return createMultiaddConfirmButtonHandler({
    client: {},
    multiaddPending: pending,
    clearMultiaddPending: (id) => pending.delete(id),
    sendBulkApprovalToApprovers: async () => assert.fail('an officer batch is written at once'),
    broadcastBulkAdd: async () => {},
    executeBulkMultiadd: async (rows, meta, onProgress) => {
      await onExecute?.(onProgress);
      return { added: [], skipped: [], failed: [] };
    },
    buildBulkSummaryEmbed: () => ({ title: 'summary' }),
  });
}

function clickBy(userId, prefix = 'multiadd_confirm') {
  const updates = [];
  const edits = [];
  const replies = [];
  return {
    updates,
    edits,
    replies,
    customId: `${prefix}:req-1`,
    user: { id: userId, tag: 'User#0001' },
    guild: { id: 'guild-1' },
    update: async (payload) => { updates.push(payload); },
    editReply: async (payload) => { edits.push(payload); },
    reply: async (payload) => { replies.push(payload); },
  };
}

const cardOf = (payload) => payload.embeds[0].toJSON();

test('multi-add: the processing notice is a progress notice without a bar, and the progress notice shows the scan bar', async (t) => {
  const handler = setup(t, { onExecute: async (onProgress) => { await onProgress(5, 10); } });
  const click = clickBy('officer-1');
  await handler(click);

  const processing = cardOf(click.updates[0]);
  assert.ok(processing.title.startsWith('⏳  '), processing.title);
  assert.equal(processing.color, COLORS.info);
  assert.doesNotMatch(processing.description || '', /[█░]/);
  assert.ok(processing.footer.text.startsWith('💡 '), processing.footer.text);

  const progress = cardOf(click.edits[0]);
  assert.ok(progress.title.startsWith('⏳  '), progress.title);
  assert.match(progress.title, /10/);
  assert.match(progress.description, /\*\*5\/10\*\*/);
  assert.ok(progress.description.includes(`\`${buildProgressBar(50)}\` 50%`), progress.description);
});

test('multi-add: an expired preview is an expired notice', async (t) => {
  const handler = setup(t, { pendingRows: null });
  const click = clickBy('officer-1');
  await handler(click);

  const card = cardOf(click.updates[0]);
  assert.ok(card.title.startsWith('⌛  '), card.title);
  assert.equal(card.color, COLORS.muted);
});

test('multi-add: a file someone else uploaded is a guard notice', async (t) => {
  const handler = setup(t);
  const click = clickBy('member-2');
  await handler(click);

  const card = cardOf(click.replies[0]);
  assert.ok(card.title.startsWith('🔒  '), card.title);
  assert.equal(card.color, COLORS.warning);
});
