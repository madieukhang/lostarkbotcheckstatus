import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import UserPreference from '../bot/models/UserPreference.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { createListEditCommandHandler } from '../bot/handlers/list/edit/command.js';

function mockEditLookup(t, entries) {
  clearUserLanguageCache();
  invalidateGuildConfig('image-guild');
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => {
    clearUserLanguageCache();
    invalidateGuildConfig('image-guild');
    await disconnectDB();
  });
  const nullQuery = () => ({ collation() { return this; }, lean: async () => null, then: resolve => resolve(null) });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ defaultBlacklistScope: 'global' }) }));
  t.mock.method(Blacklist, 'find', () => ({ collation: async () => entries }));
  t.mock.method(Blacklist, 'findOne', nullQuery);
  t.mock.method(Whitelist, 'findOne', nullQuery);
  t.mock.method(Watchlist, 'findOne', nullQuery);
  t.mock.method(TrustedUser, 'findOne', nullQuery);
}

async function runEdit(attachment) {
  const replies = [];
  const handler = createListEditCommandHandler({
    client: {},
    broadcastListChange: () => assert.fail('A refused edit must not broadcast'),
    sendListAddApprovalToApprovers: () => assert.fail('A refused edit must not ask approvers'),
    rehostImageFn: () => assert.fail('A refused edit must not rehost its image'),
  });
  await handler({
    user: { id: 'entry-owner', username: 'Owner', tag: 'Owner' },
    guild: { id: 'image-guild' }, channelId: 'channel',
    options: {
      getString: key => ({ name: 'Mainchar' })[key] || null,
      getAttachment: () => attachment,
    },
    deferReply: async () => {},
    editReply: async payload => { replies.push(payload); },
  });
  return replies;
}

test('/la-list edit refuses an attachment that is not an image', async t => {
  mockEditLookup(t, [{
    _id: 'a'.repeat(24), name: 'Mainchar', reason: 'Report',
    scope: 'global', addedByUserId: 'entry-owner', allCharacters: [],
  }]);

  const replies = await runEdit({ url: 'https://cdn.example.test/report.pdf', contentType: 'application/pdf' });

  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].toJSON().title, /not an image/);
});

test('/la-list edit does not rehost the image of an edit whose entry is missing', async t => {
  mockEditLookup(t, []);

  const replies = await runEdit({ url: 'https://cdn.example.test/proof.png', contentType: 'image/png' });

  assert.equal(replies.length, 1);
});
