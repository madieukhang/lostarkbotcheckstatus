import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Collection, MessageFlags } from 'discord.js';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import UserPreference from '../bot/models/UserPreference.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache, t as translate } from '../bot/services/i18n/index.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { buildListAddRequest, createListAddCommandHandler } from '../bot/handlers/list/add/command.js';
import { buildListEditInput, createListEditCommandHandler } from '../bot/handlers/list/edit/command.js';
import { LIST_FORM_IDS } from '../bot/handlers/list/form/fields.js';
import { createListFormHandlers } from '../bot/handlers/list/form/index.js';

const PDF = { url: 'https://cdn.example.test/report.pdf', contentType: 'application/pdf' };

// A modal submit carries no slash options; the handlers must not read any.
function formSubmit(replies) {
  return {
    user: { id: 'entry-owner', username: 'Owner', tag: 'Owner' },
    guild: { id: 'form-guild' }, channelId: 'channel',
    deferReply: async () => {},
    editReply: async (payload) => { replies.push(payload); },
  };
}

function stubLookups(t, entries = []) {
  clearUserLanguageCache();
  invalidateGuildConfig('form-guild');
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => {
    clearUserLanguageCache();
    invalidateGuildConfig('form-guild');
    await disconnectDB();
  });
  const nullQuery = () => ({ collation() { return this; }, lean: async () => null, then: (resolve) => resolve(null) });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ defaultBlacklistScope: 'global' }) }));
  t.mock.method(Blacklist, 'find', () => ({ collation: async () => entries }));
  t.mock.method(Blacklist, 'findOne', nullQuery);
  t.mock.method(Whitelist, 'findOne', nullQuery);
  t.mock.method(Watchlist, 'findOne', nullQuery);
  t.mock.method(TrustedUser, 'findOne', nullQuery);
}

test('buildListAddRequest normalizes the add fields the way the command reads them', () => {
  assert.deepEqual(buildListAddRequest({
    type: 'black', name: '  mokoko ', reason: '  Left mid-raid ', raidInput: 'serca hard', image: null, inputScope: 'server',
  }), {
    type: 'black', name: 'Mokoko', reason: 'Left mid-raid', raidInput: 'serca hard', raid: 'Serca Hard', image: null, inputScope: 'server',
  });
  assert.equal(buildListAddRequest({ type: 'white', name: 'A', reason: 'r', raidInput: 'Event Gate' }).raid, null);
  assert.equal(buildListAddRequest({ type: 'watch', name: 'A', reason: 'r', raidInput: 'Event Gate' }).raid, 'Event Gate');
});

test('buildListEditInput keeps an empty field as "keep" and drops an unknown scope', () => {
  assert.deepEqual(buildListEditInput({ name: 'mokoko' }), {
    name: 'Mokoko', newReason: '', newType: '', newRaidInput: '', imageAttachment: null, newScope: '', additionalNamesRaw: '',
  });
  assert.deepEqual(buildListEditInput({
    name: 'mokoko', reason: ' New ', type: 'black', raidInput: ' Serca NM ', image: PDF, scope: 'server', additionalNames: 'Alt1',
  }), {
    name: 'Mokoko', newReason: 'New', newType: 'black', newRaidInput: 'Serca NM', imageAttachment: PDF, newScope: 'server', additionalNamesRaw: 'Alt1',
  });
  assert.equal(buildListEditInput({ name: 'a', scope: 'elsewhere' }).newScope, '');
});

test('/la-list add runs a request read elsewhere without touching slash options', async (t) => {
  stubLookups(t);
  const replies = [];
  const handler = createListAddCommandHandler({
    client: {},
    sendListAddApprovalToApprovers: () => assert.fail('A refused add must not ask approvers'),
    executeListAddToDatabase: () => assert.fail('A refused add must not write'),
  });

  await handler(formSubmit(replies), buildListAddRequest({
    type: 'black', name: 'Mokoko', reason: 'Report', raidInput: '', image: PDF, inputScope: '',
  }));

  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].toJSON().title, /not an image/);
});

test('/la-list edit runs an input read elsewhere without touching slash options', async (t) => {
  stubLookups(t, [{
    _id: 'a'.repeat(24), name: 'Mokoko', reason: 'Report', scope: 'global', addedByUserId: 'entry-owner', allCharacters: [],
  }]);
  const replies = [];
  const handler = createListEditCommandHandler({
    client: {},
    broadcastListChange: () => assert.fail('A refused edit must not broadcast'),
    sendListAddApprovalToApprovers: () => assert.fail('A refused edit must not ask approvers'),
    rehostImageFn: () => assert.fail('A refused edit must not rehost its image'),
  });

  await handler(formSubmit(replies), buildListEditInput({ name: 'Mokoko', image: PDF }));

  assert.equal(replies.length, 1);
  assert.match(replies[0].embeds[0].toJSON().title, /not an image/);
});

// The submit of a form: the ids in `values` were filled in.
function formFields(values) {
  return {
    fields: new Map(Object.keys(values).map((id) => [id, {}])),
    getTextInputValue: (id) => values[id],
    getStringSelectValues: (id) => values[id],
    getUploadedFiles: (id) => values[id],
  };
}

test('an add form with a PDF gets the same notice as /la-list add', async (t) => {
  stubLookups(t);
  const replies = [];
  const { handleListAddFormSubmit } = createListFormHandlers({
    handleListAddCommand: createListAddCommandHandler({
      client: {},
      sendListAddApprovalToApprovers: () => assert.fail('A refused add must not ask approvers'),
      executeListAddToDatabase: () => assert.fail('A refused add must not write'),
    }),
    handleListEditCommand: () => assert.fail('not an edit'),
  });

  await handleListAddFormSubmit({
    ...formSubmit(replies),
    fields: formFields({
      [LIST_FORM_IDS.type]: ['black'],
      [LIST_FORM_IDS.name]: 'Mokoko',
      [LIST_FORM_IDS.reason]: 'Report',
      [LIST_FORM_IDS.image]: new Collection([['1', PDF]]),
    }),
  });

  assert.match(replies[0].embeds[0].toJSON().title, /not an image/);
});

test('an edit form with only the name gets the no-changes notice', async (t) => {
  stubLookups(t, [{
    _id: 'a'.repeat(24), name: 'Mokoko', reason: 'Report', scope: 'global', addedByUserId: 'entry-owner', allCharacters: [],
  }]);
  const replies = [];
  const { handleListEditFormSubmit } = createListFormHandlers({
    handleListAddCommand: () => assert.fail('not an add'),
    handleListEditCommand: createListEditCommandHandler({
      client: {},
      broadcastListChange: () => assert.fail('A refused edit must not broadcast'),
      sendListAddApprovalToApprovers: () => assert.fail('A refused edit must not ask approvers'),
    }),
  });

  await handleListEditFormSubmit({ ...formSubmit(replies), fields: formFields({ [LIST_FORM_IDS.name]: 'Mokoko' }) });

  assert.ok(replies[0].embeds[0].toJSON().title.includes(translate('dialogue.listEdit.command.noChanges', 'en').title));
});

test('a quick add answers privately and leaves the request message unrecorded', async (t) => {
  stubLookups(t);
  t.mock.method(PendingApproval, 'create', async (doc) => doc);
  // captureRequestReplyId catches its own errors, so record the calls instead of failing inside them.
  const recorded = [];
  t.mock.method(PendingApproval, 'updateOne', async () => { recorded.push('updateOne'); });
  const deferred = [];
  const replies = [];
  const { handleQuickAddFormSubmit } = createListFormHandlers({
    handleListAddCommand: createListAddCommandHandler({
      client: {},
      sendListAddApprovalToApprovers: async () => ({ success: true, deliveredApproverIds: ['senior'], deliveredDmMessages: [] }),
      executeListAddToDatabase: () => assert.fail('a member add waits for an approver'),
    }),
    handleListEditCommand: () => assert.fail('not an edit'),
  });

  await handleQuickAddFormSubmit({
    ...formSubmit(replies),
    deferReply: async (options) => { deferred.push(options); },
    fetchReply: async () => { recorded.push('fetchReply'); return { id: 'reply-1' }; },
    fields: formFields({ [LIST_FORM_IDS.type]: ['black'], [LIST_FORM_IDS.name]: 'Mokoko', [LIST_FORM_IDS.reason]: 'Report' }),
  });

  assert.deepEqual(deferred, [{ flags: MessageFlags.Ephemeral }]);
  assert.deepEqual(recorded, [], 'a private reply cannot be fetched back from its channel later');
  assert.equal(replies.at(-1).embeds[0].toJSON().title, '📨 Blacklist · Sent for approval · Mokoko');
});
