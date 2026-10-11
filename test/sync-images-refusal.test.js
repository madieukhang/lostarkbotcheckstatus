import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { handleSyncImagesAction } from '../bot/handlers/setup/syncImages.js';

// A legacy link the rehost guard refuses can never be archived, so the
// migration counts it as dead at once instead of waiting and retrying.
test('/la-remote syncimages counts a refused legacy link as dead without a retry', async t => {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'sync-images-owner';
  t.after(() => { config.ownerGuildId = ownerGuildId; invalidateGuildConfig('sync-images-owner'); });
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ evidenceChannelId: 'evidence' }) }));
  const legacy = [{ _id: 'e1', name: 'Legacytarget', imageUrl: 'http://10.0.0.5/evidence.png', imageMessageId: '' }];
  t.mock.method(Blacklist, 'find', () => ({ lean: async () => legacy }));
  t.mock.method(Whitelist, 'find', () => ({ lean: async () => [] }));
  t.mock.method(Watchlist, 'find', () => ({ lean: async () => [] }));
  t.mock.method(globalThis, 'fetch', async url => assert.fail(`unexpected request to ${url}`));
  t.mock.method(console, 'warn', () => {});
  const replies = [];
  const interaction = {
    user: { tag: 'senior' },
    client: { channels: { fetch: async () => assert.fail('a refused link must not be uploaded') } },
    deferred: true,
    editReply: async payload => { replies.push(payload); },
    followUp: async payload => { replies.push(payload); },
  };

  const startedAt = Date.now();
  await handleSyncImagesAction(interaction, 'en');

  assert.ok(Date.now() - startedAt < 1500, 'no retry wait for a refusal');
  const summary = JSON.stringify(replies.at(-1));
  assert.match(summary, /Legacytarget: download refused/);
  const fields = replies.at(-1).embeds[0].toJSON().fields;
  const dead = fields.find(field => /dead|skipped/i.test(field.name));
  assert.equal(dead?.value, '1', JSON.stringify(fields));
});
