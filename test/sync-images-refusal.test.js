import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import EvidenceImage from '../bot/models/EvidenceImage.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { handleSyncImagesAction } from '../bot/handlers/setup/syncImages.js';

// legacy: entries the first pass rehosts; archived: entries on an archive
// message; stored: archive ids that already have a database copy.
function setup(t, { legacy = [], archived = [], stored = [] } = {}) {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'sync-images-owner';
  t.after(() => { config.ownerGuildId = ownerGuildId; invalidateGuildConfig('sync-images-owner'); });
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ evidenceChannelId: 'evidence' }) }));
  const listQuery = rows => filter => {
    const query = { select: () => query, lean: async () => (filter.imageUrl ? rows.legacy : rows.archived) };
    return query;
  };
  t.mock.method(Blacklist, 'find', listQuery({ legacy, archived }));
  t.mock.method(Whitelist, 'find', listQuery({ legacy: [], archived: [] }));
  t.mock.method(Watchlist, 'find', listQuery({ legacy: [], archived: [] }));
  t.mock.method(EvidenceImage, 'distinct', async () => stored);
  const copies = [];
  t.mock.method(EvidenceImage, 'updateOne', async (filter, update) => { copies.push({ filter, update }); return {}; });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
}

function interactionFor({ archive = {}, failComplete = false } = {}) {
  const replies = [];
  const channel = {
    id: 'evidence',
    isTextBased: () => true,
    messages: { fetch: async ({ message }) => ({ attachments: { first: () => ({ url: archive[message] }) } }) },
  };
  return {
    replies,
    user: { tag: 'senior' },
    client: { channels: { fetch: async () => channel } },
    deferred: true,
    editReply: async payload => {
      if (failComplete && /Complete/.test(payload.embeds?.[0]?.toJSON().title)) throw new Error('Unknown Webhook');
      replies.push(payload);
    },
    followUp: async payload => { replies.push(payload); },
  };
}

const fieldValue = (reply, pattern) => reply.embeds[0].toJSON().fields.find(field => pattern.test(field.name))?.value;
const imageResponse = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });

// A legacy link the rehost guard refuses can never be archived, so the
// migration counts it as dead at once instead of waiting and retrying.
test('/la-remote syncimages counts a refused legacy link as dead without a retry', async t => {
  setup(t, { legacy: [{ _id: 'e1', name: 'Legacytarget', imageUrl: 'http://10.0.0.5/evidence.png', imageMessageId: '' }] });
  t.mock.method(globalThis, 'fetch', async url => assert.fail(`unexpected request to ${url}`));
  const interaction = interactionFor();
  interaction.client.channels.fetch = async () => assert.fail('a refused link must not be uploaded');

  const startedAt = Date.now();
  await handleSyncImagesAction(interaction, 'en');

  assert.ok(Date.now() - startedAt < 1500, 'no retry wait for a refusal');
  const summary = JSON.stringify(interaction.replies.at(-1));
  assert.match(summary, /Legacytarget: download refused/);
  const fields = interaction.replies.at(-1).embeds[0].toJSON().fields;
  const dead = fields.find(field => /dead|skipped/i.test(field.name));
  assert.equal(dead?.value, '1', JSON.stringify(fields));
});

test('syncimages copies archive messages the database does not hold yet', async t => {
  setup(t, {
    archived: [
      { name: 'Stored', imageMessageId: 'm1', imageChannelId: 'evidence' },
      { name: 'Missing', imageMessageId: 'm2', imageChannelId: 'evidence' },
    ],
    stored: ['m1'],
  });
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async url => { downloads.push(String(url)); return imageResponse(); });
  const interaction = interactionFor({ archive: { m2: 'https://cdn.discordapp.com/attachments/1/2/proof.png' } });

  await handleSyncImagesAction(interaction, 'en');

  assert.deepEqual(downloads, ['https://cdn.discordapp.com/attachments/1/2/proof.png']);
  assert.equal(interaction.replies.length > 0, true);
  const summary = interaction.replies.at(-1);
  assert.equal(fieldValue(summary, /Copied to database/), '1');
  assert.equal(fieldValue(summary, /Left for next run/), '0');
});

test('syncimages stops starting copies after its time budget and says how many are left', async t => {
  setup(t, {
    archived: [
      { name: 'First', imageMessageId: 'm2', imageChannelId: 'evidence' },
      { name: 'Second', imageMessageId: 'm3', imageChannelId: 'evidence' },
    ],
  });
  // The first download takes the whole budget.
  let clock = 0;
  t.mock.method(globalThis, 'fetch', async () => { clock = 1000; return imageResponse(); });
  const interaction = interactionFor({ archive: { m2: 'https://cdn.discordapp.com/a.png', m3: 'https://cdn.discordapp.com/b.png' } });

  await handleSyncImagesAction(interaction, 'en', { now: () => clock, copyBudgetMs: 1000 });

  const summary = interaction.replies.at(-1);
  assert.equal(fieldValue(summary, /Copied to database/), '1');
  assert.equal(fieldValue(summary, /Left for next run/), '1');
  // The image left for the next run was not checked in this one.
  assert.match(summary.embeds[0].toJSON().description, /\*\*1\*\* archived images/);
});

test('syncimages counts a gone archive message as dead and a failed download as failed', async t => {
  setup(t, {
    archived: [
      { name: 'Gone', imageMessageId: 'm2', imageChannelId: 'evidence' },
      { name: 'Broken', imageMessageId: 'm3', imageChannelId: 'evidence' },
    ],
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 500 }));
  const interaction = interactionFor({ archive: { m3: 'https://cdn.discordapp.com/b.png' } });

  await handleSyncImagesAction(interaction, 'en');

  const summary = interaction.replies.at(-1);
  assert.equal(fieldValue(summary, /Copied to database/), '0');
  assert.equal(fieldValue(summary, /Dead URLs/), '1');
  assert.equal(fieldValue(summary, /Failed/), '1');
  const errors = fieldValue(summary, /Errors/);
  assert.match(errors, /Gone: archive message is gone/);
  assert.match(errors, /Broken: download HTTP 500/);
});

test('syncimages reports nothing to do only when both passes are empty', async t => {
  setup(t, { archived: [{ name: 'Stored', imageMessageId: 'm1', imageChannelId: 'evidence' }], stored: ['m1'] });
  t.mock.method(globalThis, 'fetch', async url => assert.fail(`unexpected request to ${url}`));
  const interaction = interactionFor();

  await handleSyncImagesAction(interaction, 'en');

  assert.equal(interaction.replies.length, 1);
  assert.match(interaction.replies[0].embeds[0].toJSON().title, /Nothing to do/);
});

test('a failed summary edit is logged, not thrown', async t => {
  setup(t, { archived: [{ name: 'Missing', imageMessageId: 'm2', imageChannelId: 'evidence' }] });
  t.mock.method(globalThis, 'fetch', async () => imageResponse());
  const interaction = interactionFor({ archive: { m2: 'https://cdn.discordapp.com/a.png' }, failComplete: true });

  await handleSyncImagesAction(interaction, 'en');

  assert.ok(console.warn.mock.calls.some(call => /summary/i.test(String(call.arguments[0]))));
});
