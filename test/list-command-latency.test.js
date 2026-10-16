import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/unused_fixture';

const { createListEditCommandHandler } = await import('../bot/handlers/list/edit/command.js');
const { createApprovalDecisionHandler } = await import('../bot/handlers/list/services/approvalInteraction.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: PendingApproval } = await import('../bot/models/PendingApproval.js');
const { disconnectDB } = await import('../bot/db.js');
const { clearUserLanguageCache, t: translate } = await import('../bot/services/i18n/index.js');
const { invalidateGuildConfig } = await import('../bot/utils/scope.js');
const { mockPendingApprovalModel } = await import('./helpers/pending-approval-model.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

test.beforeEach(() => { clearUserLanguageCache(); invalidateGuildConfig('latency-guild'); });
test.afterEach(async () => { await disconnectDB(); clearUserLanguageCache(); invalidateGuildConfig('latency-guild'); });

test('list edit acknowledges before reads and overlaps locale, guild config and target lookup', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const events = [];
  t.mock.method(mongoose, 'connect', async () => mongoose);
  const load = async (label, value) => { events.push(label); await held; return value; };
  t.mock.method(UserPreference, 'findOne', () => ({ lean: () => load('locale', { language: 'vi' }) }));
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: () => load('guild', {}) }));
  t.mock.method(Blacklist, 'find', () => ({ collation: () => load('black', []) }));
  t.mock.method(Whitelist, 'findOne', () => ({ collation: () => load('white', null) }));
  t.mock.method(Watchlist, 'findOne', () => ({ collation: () => load('watch', null) }));
  const handler = createListEditCommandHandler({ client: {},
    sendListAddApprovalToApprovers: () => assert.fail('no target'),
    broadcastListChange: () => assert.fail('no target'),
  });
  const pending = handler({
    user: { id: 'latency-user' }, guild: { id: 'latency-guild' },
    options: { getString: key => key === 'name' ? 'Alpha' : null, getAttachment: () => null },
    deferReply: async () => events.push('ack'),
    editReply: async () => events.push('reply'),
  });
  try {
    await tick();
    assert.equal(events[0], 'ack');
    assert.deepEqual(new Set(events.slice(1)), new Set(['locale', 'guild', 'black', 'white', 'watch']));
    assert.ok(!events.includes('reply'));
  } finally { release(); await pending; }
  assert.equal(events.at(-1), 'reply');
});

test('list edit outside a server answers server-only in the user language without database work', async t => {
  t.mock.method(mongoose, 'connect', async () => assert.fail('no connection outside a server'));
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'vi' }) }));
  const handler = createListEditCommandHandler({ client: {},
    sendListAddApprovalToApprovers: () => assert.fail('no target'),
    broadcastListChange: () => assert.fail('no target'),
  });
  const replies = [];
  await handler({
    user: { id: 'latency-user' }, guild: null,
    deferReply: async () => assert.fail('a refusal needs no deferral'),
    reply: async payload => replies.push(payload),
  });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].embeds[0].toJSON().description, translate('dialogue.common.serverOnly', 'vi').description);
});

test('approval acknowledges before connection and overlaps the claim with locale loading', async t => {
  let connect, locale;
  const connected = new Promise(resolve => { connect = resolve; });
  const localized = new Promise(resolve => { locale = resolve; });
  const events = [];
  t.mock.method(mongoose, 'connect', async () => { events.push('connect'); await connected; return mongoose; });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => { await localized; return { language: 'vi' }; } }));
  const stored = mockPendingApprovalModel(t, PendingApproval, { requestId: 'request', approverIds: ['officer'] });
  const handler = createApprovalDecisionHandler(async ({ claim, lang }) => {
    assert.equal(lang, 'vi');
    events.push('decision');
    await claim.complete();
  });
  const pending = handler({ user: { id: 'officer' }, customId: 'approve:request',
    deferUpdate: async () => events.push('ack'),
  });
  try {
    await tick();
    assert.deepEqual(events, ['ack', 'connect']);
    assert.equal(stored.calls.claims.length, 0);
    connect();
    await tick();
    assert.equal(stored.calls.claims.length, 1, 'locale latency must not hold up the claim');
    assert.ok(!events.includes('decision'), 'decision needs the resolved locale');
  } finally { connect(); locale(); await pending; }
  assert.deepEqual(events, ['ack', 'connect', 'decision']);
  assert.equal(stored.get(), null);
});
