import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildDecidedApprovalPayload, buildListAddApprovalEmbed } = await import('../bot/handlers/list/helpers.js');
const { buildPreviewReply } = await import('../bot/handlers/list/multiadd/ui.js');
const { createApprovalServices } = await import('../bot/handlers/list/services/approvals.js');
const { createBroadcastServices } = await import('../bot/handlers/list/services/broadcasts.js');
const { createBulkServices } = await import('../bot/handlers/list/services/bulk.js');
const { default: GuildConfig } = await import('../bot/models/GuildConfig.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');

const LINK_NAME = '[Free Gold](https://evil.example)';
const ESCAPED_LINK_NAME = '\\[Free Gold\\](https://evil.example)';

function textOf(embed) {
  const data = embed.toJSON ? embed.toJSON() : embed;
  return [data.title, data.description, ...(data.fields || []).flatMap((field) => [field.name, field.value])]
    .filter(Boolean)
    .join('\n');
}

function assertNoLiveLink(text) {
  assert.ok(text.includes(ESCAPED_LINK_NAME), `escaped name missing in: ${text}`);
  assert.equal(text.includes(LINK_NAME), false, 'raw masked link must not survive');
  assert.equal(text.replaceAll('\\]', '').includes(']('), false, 'unescaped masked link must not survive');
}

const approvalPayload = {
  requestId: 'request-1',
  type: 'black',
  name: LINK_NAME,
  reason: 'reason',
  scope: 'global',
  requestedByDisplayName: 'Requester',
  requestedByUserId: 'requester-1',
};

test('approver approval card escapes a bracketed name in title and hero', () => {
  const embed = buildListAddApprovalEmbed({ name: 'Guild' }, approvalPayload);
  assert.ok(embed.toJSON().title.includes(ESCAPED_LINK_NAME));
  assert.ok(embed.toJSON().description.includes(ESCAPED_LINK_NAME));
  assert.equal(embed.toJSON().title.includes(LINK_NAME), false);
  assert.equal(embed.toJSON().description.includes(LINK_NAME), false);
});

test('requester approval card escapes a bracketed name in title and hero', () => {
  const embed = buildListAddApprovalEmbed({ name: 'Guild' }, approvalPayload, { forRequester: true });
  const { title, description } = embed.toJSON();
  assert.ok(title.includes(ESCAPED_LINK_NAME));
  assert.equal(title.includes(LINK_NAME), false);
  assert.equal(description.includes(LINK_NAME), false);
});

test('multiadd preview escapes a bracketed name', () => {
  const reply = buildPreviewReply({
    rows: [{ name: LINK_NAME, type: 'black', reason: 'reason', scope: '' }],
    errors: [],
  }, 'request-1', 'en');
  assertNoLiveLink(textOf(reply.embeds[0]));
});

test('bulk summary escapes a bracketed name in every outcome line', () => {
  const { buildBulkSummaryEmbed } = createBulkServices({
    client: {},
    executeListAddToDatabase: async () => ({ ok: true }),
  });
  const embed = buildBulkSummaryEmbed({
    added: [{ name: LINK_NAME, type: 'black' }],
    skipped: [{ name: LINK_NAME, reason: 'duplicate' }],
    failed: [{ name: LINK_NAME, error: 'write failed' }],
    rehostWarnings: [{ name: LINK_NAME, error: 'upload failed' }],
  }, { requesterDisplayName: 'Tester' }, 'en');
  const fields = embed.toJSON().fields;
  assert.equal(fields.length, 4);
  for (const field of fields) assertNoLiveLink(field.value);
});

test('senior bulk approval DM escapes a bracketed name', async () => {
  const sent = [];
  const services = createApprovalServices({
    client: {
      users: {
        fetch: async (id) => ({ id, bot: false, send: async (message) => { sent.push(message); return { id: 'message', channelId: 'dm' }; } }),
      },
    },
    getUserLanguageFn: async () => 'en',
    getSeniorApproverIdsFn: () => ['senior'],
  });
  const result = await services.sendBulkApprovalToApprovers({ id: 'guild-1', name: 'Guild' }, {
    requestId: 'bulk-1',
    requesterId: 'requester-1',
    requesterDisplayName: 'Requester',
    guildId: 'guild-1',
    rows: [{ type: 'black', name: LINK_NAME, reason: 'reason', scope: 'global', raid: '' }],
  });
  assert.equal(result.success, true);
  assertNoLiveLink(textOf(sent[0].embeds[0]));
});

test('requester decision notice escapes a bracketed name in its title', async () => {
  const sent = [];
  const channel = { isTextBased: () => true, send: async (message) => sent.push(message) };
  const services = createApprovalServices({
    client: { guilds: { fetch: async () => ({ id: 'guild-1', channels: { fetch: async () => channel } }) } },
    getGuildLanguageFn: async () => 'en',
    RosterSnapshotModel: { findOne: () => ({ collation() { return this; }, lean: async () => null }) },
  });
  await services.notifyRequesterAboutDecision({
    ...approvalPayload,
    guildId: 'guild-1',
    channelId: 'channel-1',
    requestedByUserId: 'requester-1',
  }, { ok: true });
  assert.equal(sent.length, 1);
  assertNoLiveLink(sent[0].embeds[0].toJSON().title);
});

test('bulk broadcast line escapes a bracketed name', async (t) => {
  t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
  t.mock.method(GuildConfig, 'find', () => ({
    lean: async () => [{ guildId: 'other-guild', listNotifyChannelId: 'channel-1' }],
  }));
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const sent = [];
  const channel = { isTextBased: () => true, guild: { id: 'other-guild' }, send: async (message) => sent.push(message) };
  const { broadcastBulkAdd } = createBroadcastServices({
    client: { channels: { fetch: async () => channel } },
  });
  await broadcastBulkAdd(
    [{ type: 'black', entry: { name: LINK_NAME, type: 'black', reason: 'reason', scope: 'global' } }],
    { guildId: 'origin-guild' },
  );
  assert.equal(sent.length, 1);
  const { fields } = sent[0].embeds[0].toJSON();
  assert.equal(fields.length, 1);
  assertNoLiveLink(fields[0].value);
});

test('decided approval card escapes a bracketed name in its title', () => {
  const { embeds } = buildDecidedApprovalPayload({
    client: { guilds: { cache: new Map() } },
    payload: { ...approvalPayload, guildId: 'guild-1' },
    outcome: 'approved',
    approver: 'Senior',
    lang: 'en',
  });
  assertNoLiveLink(embeds[0].toJSON().title);
});
