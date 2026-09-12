import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import UserPreference from '../bot/models/UserPreference.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { createListEditCommandHandler } from '../bot/handlers/list/edit/command.js';
import { handleApprovedEditRequest, buildApprovalMoveData } from '../bot/handlers/list/add/editApproval.js';
import { buildListAddApprovalEmbed } from '../bot/handlers/list/helpers.js';

for (const delivered of [true, false]) {
  test(`server-to-global owner edit waits for approval (delivery=${delivered})`, async t => {
    clearUserLanguageCache();
    invalidateGuildConfig('scope-guild');
    t.mock.method(mongoose, 'connect', async () => mongoose);
    t.after(async () => {
      clearUserLanguageCache();
      invalidateGuildConfig('scope-guild');
      await disconnectDB();
    });
    const entry = {
      _id: 'a'.repeat(24), name: 'Mainchar', reason: 'Server report',
      scope: 'server', guildId: 'scope-guild', addedByUserId: 'entry-owner',
      allCharacters: ['Existingalt'],
    };
    const nullQuery = () => ({ collation() { return this; }, lean: async () => null, then: resolve => resolve(null) });
    t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
    t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ defaultBlacklistScope: 'server' }) }));
    t.mock.method(Blacklist, 'find', () => ({ collation: async () => [entry] }));
    t.mock.method(Blacklist, 'findOne', nullQuery);
    t.mock.method(Whitelist, 'findOne', nullQuery);
    t.mock.method(Watchlist, 'findOne', nullQuery);
    t.mock.method(Blacklist, 'updateOne', () => assert.fail('Pending edit must not update the entry'));
    const saved = [];
    t.mock.method(PendingApproval, 'create', async payload => { saved.push(payload); });
    let requested;
    const replies = [];
    const handler = createListEditCommandHandler({
      client: {},
      broadcastListChange: () => assert.fail('Pending edit must not broadcast'),
      sendListAddApprovalToApprovers: async (_guild, payload) => {
        requested = payload;
        return { success: delivered, deliveredApproverIds: ['officer'], deliveredDmMessages: [] };
      },
    });
    await handler({
      user: { id: 'entry-owner', username: 'Owner', tag: 'Owner' },
      guild: { id: 'scope-guild' }, channelId: 'channel',
      options: {
        getString: key => ({ name: 'Mainchar', scope: 'global', additional_names: 'Newalt' })[key] || null,
        getAttachment: () => null,
      },
      deferReply: async () => {},
      editReply: async payload => { replies.push(payload); },
    });
    assert.equal(requested.scope, 'global');
    assert.equal(requested.action, 'edit');
    assert.equal(requested.existingEntryId, entry._id);
    assert.deepEqual(requested.additionalNames, ['Newalt']);
    const card = buildListAddApprovalEmbed({ name: 'Guild' }, requested).toJSON();
    assert.ok(card.fields.some(field => field.value.includes('Newalt')));
    assert.equal(entry.scope, 'server');
    assert.deepEqual(entry.allCharacters, ['Existingalt']);
    assert.equal(saved.length, delivered ? 1 : 0);
    if (delivered) {
      const persisted = new PendingApproval(saved[0]);
      assert.deepEqual([...persisted.additionalNames], ['Newalt']);
      assert.deepEqual(saved[0].approverIds, ['officer']);
    }
    assert.equal(replies.length, 1);
  });
}

test('approval promotes scope and appends requested alts without replacing newer stored alts', async t => {
  const entry = {
    _id: 'a'.repeat(24), name: 'Mainchar', reason: 'Server report',
    scope: 'server', guildId: 'scope-guild',
    allCharacters: ['Existingalt', 'Concurrentalt'],
  };
  const payload = {
    requestId: 'request', existingEntryId: entry._id, action: 'edit',
    currentType: 'black', type: 'black', scope: 'global', guildId: 'scope-guild',
    additionalNames: ['Newalt'],
  };
  const events = [];
  t.mock.method(Blacklist, 'findById', async () => entry);
  t.mock.method(Blacklist, 'updateOne', async (_filter, update) => {
    events.push('write');
    assert.deepEqual(update, {
      $set: { scope: 'global', guildId: '' },
      $addToSet: { allCharacters: { $each: ['Newalt'] } },
    });
  });
  t.mock.method(PendingApproval, 'deleteOne', async () => { events.push('close'); });
  await handleApprovedEditRequest({
    interaction: {
      user: { id: 'officer', tag: 'Officer' }, message: { id: 'dm' },
      editReply: async () => { events.push('reply'); },
    },
    payload, requestId: 'request',
    syncApproverDmMessages: async () => {},
    broadcastListChange: async (_action, result, _meta, options) => {
      assert.equal(result.scope, 'global');
      assert.equal(options.onlyOwner, false);
      assert.deepEqual(result.allCharacters, ['Existingalt', 'Concurrentalt', 'Newalt']);
    },
    notifyRequesterAboutDecision: async () => { events.push('notify'); },
  });
  assert.deepEqual(events, ['write', 'close', 'reply', 'notify']);
  assert.deepEqual(buildApprovalMoveData(payload, entry).allCharacters, ['Existingalt', 'Concurrentalt', 'Newalt']);
});
