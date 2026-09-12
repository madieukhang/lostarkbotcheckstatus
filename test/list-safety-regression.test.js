import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import UserPreference from '../bot/models/UserPreference.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { createCheckHandlers } from '../bot/handlers/list/check/index.js';
import { loadSearchDetailEntry, getSearchDetailResults, buildSearchDetailComponents } from '../bot/handlers/search/evidence.js';
import { buildListViewComponents } from '../bot/handlers/list/view/ui.js';
import { buildListEditPlan } from '../bot/handlers/list/edit/plan.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { createListEditCommandHandler } from '../bot/handlers/list/edit/command.js';
import { buildScopedListQuery } from '../bot/utils/scope.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import { handleApprovedEditRequest } from '../bot/handlers/list/add/editApproval.js';
import { createEnrichHandlers } from '../bot/handlers/list/enrich/index.js';
import { createEnrichSession, clearEnrichSession } from '../bot/handlers/list/enrich/state.js';

for (const protectedAlt of [true, false]) {
  test(`enrich confirm enforces the current Trusted roster boundary (protected=${protectedAlt})`, async t => {
    clearUserLanguageCache();
    t.mock.method(mongoose, 'connect', async () => mongoose);
    const session = createEnrichSession({
      callerId: 'officer', type: 'black', entryId: 'f'.repeat(24), entryName: 'Original',
      newAlts: [{ name: 'Trustedalt' }], scanStats: {},
    });
    t.after(async () => { clearEnrichSession(session.sessionId); clearUserLanguageCache(); await disconnectDB(); });
    t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
    t.mock.method(Blacklist, 'findById', () => ({ lean: async () => ({ name: 'Original', allCharacters: ['Original'] }) }));
    t.mock.method(TrustedUser, 'findOne', query => {
      assert.match(JSON.stringify(query), /Trustedalt/);
      return { collation() { return this; }, lean: async () => protectedAlt ? { name: 'Trustedalt', reason: 'Protected' } : null };
    });
    let writes = 0;
    t.mock.method(Blacklist, 'updateOne', async () => { writes += 1; return { modifiedCount: 1 }; });
    await createEnrichHandlers({ services: {} }).handleListEnrichConfirmButton({
      customId: `list:confirm:${session.sessionId}`, user: { id: 'officer' },
      deferUpdate: async () => {}, editReply: async () => {},
    });
    assert.equal(writes, protectedAlt ? 0 : 1);
  });
}

test('old auto-check menu denies an entry moved into another guild', async t => {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  const entry = {
    _id: 'a'.repeat(24), name: 'Privacycase', scope: 'server', guildId: 'private-guild',
    reason: 'PRIVATE_REASON_AFTER_SCOPE_CHANGE',
  };
  const queries = [];
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(RosterSnapshot, 'find', () => ({ collation() { return this; }, lean: async () => [] }));
  t.mock.method(Blacklist, 'findOne', query => {
    queries.push(query);
    // Same current record is visible by id but excluded by the normal scope query.
    return { lean: async () => query.$and ? null : entry };
  });
  let response;
  await createCheckHandlers({ client: {} }).handleAutoCheckEvidenceSelect({
    user: { id: 'ordinary-user' }, guild: { id: 'other-guild' }, guildId: 'other-guild',
    values: [`black:${entry._id}`],
    deferReply: async () => {}, editReply: async payload => { response = payload; },
  });
  assert.deepEqual(queries[0], buildScopedListQuery('black', { _id: entry._id }, 'other-guild'));
  assert.doesNotMatch(JSON.stringify(response.embeds[0].toJSON()), /PRIVATE_REASON_AFTER_SCOPE_CHANGE/);
  assert.equal(await loadSearchDetailEntry({ entry, listType: 'black' }, 'other-guild'), null);

});

test('search and list-view one-item menus include a reset option', () => {
  const entry = {
    _id: 'b'.repeat(24), name: 'Onlychar', reason: 'Report',
    imageUrl: 'https://example.test/evidence.png', _icon: '⛔', _listType: 'black',
  };
  const searchRows = buildSearchDetailComponents(getSearchDetailResults([{ name: entry.name, black: entry }]));
  const viewRows = buildListViewComponents({ allEntries: [entry], itemsPerPage: 8, page: 0, totalPages: 1 });
  for (const [rows, selectedValue] of [[searchRows, '0'], [viewRows, `black:${entry._id}`]]) {
    const menu = rows.flatMap(row => row.toJSON().components).find(component => component.type === 3);
    assert.deepEqual(menu.options.map(option => option.value), [selectedValue, 'none']);
    assert.notEqual(menu.min_values, 0);
  }
});

test('NEGATIVE CONTROL: hydrated legacy blacklist keeps global scope on metadata edit', () => {
  const existing = Blacklist.hydrate({ _id: 'c'.repeat(24), name: 'Legacy' });
  const plan = buildListEditPlan({ existing, currentType: 'black', newReason: 'New reason', guildDefaultScope: 'server' });
  assert.equal(plan.targetScope, 'global');
  assert.equal(plan.isScopeChange, false);
});

test('owner cannot add a Trusted character through additional_names', async t => {
  clearUserLanguageCache();
  invalidateGuildConfig('edit-guild');
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => { clearUserLanguageCache(); invalidateGuildConfig('edit-guild'); await disconnectDB(); });
  const entry = {
    _id: 'd'.repeat(24), name: 'Original', reason: 'Original report', scope: 'global',
    addedByUserId: 'original-owner', allCharacters: ['Original'],
  };
  const trusted = { _id: 'e'.repeat(24), name: 'Trustedchar', reason: 'Protected user' };
  let trustedReads = 0;
  let write;
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ defaultBlacklistScope: 'global' }) }));
  t.mock.method(Blacklist, 'find', () => ({ collation: async () => [entry] }));
  t.mock.method(Whitelist, 'findOne', () => ({ collation: async () => null }));
  t.mock.method(Watchlist, 'findOne', () => ({ collation: async () => null }));
  t.mock.method(TrustedUser, 'findOne', () => { trustedReads += 1; return { collation() { return this; }, lean: async () => trusted }; });
  t.mock.method(Blacklist, 'updateOne', async (_filter, update) => { write = update; return { modifiedCount: 1 }; });
  await createListEditCommandHandler({
    client: {}, broadcastListChange: async () => {},
    sendListAddApprovalToApprovers: () => assert.fail('Current owner route does not ask for approval'),
  })({
    user: { id: 'original-owner', username: 'Owner' }, guild: { id: 'edit-guild' },
    options: { getString: key => ({ name: 'Original', additional_names: 'Trustedchar' })[key] || null, getAttachment: () => null },
    deferReply: async () => {}, editReply: async () => {},
  });
  assert.equal(trustedReads, 1);
  assert.equal(write, undefined);

});

for (const currentType of ['black', 'white']) {
  test(`approval rechecks newly Trusted alts before a ${currentType}-to-black edit`, async t => {
    const existing = { _id: 'd'.repeat(24), name: 'Original', allCharacters: ['Originalalt'], scope: 'server' };
    const oldModel = currentType === 'black' ? Blacklist : Whitelist;
    t.mock.method(oldModel, 'findById', async () => existing);
    let trustedQuery;
    t.mock.method(TrustedUser, 'findOne', query => {
      trustedQuery = query;
      return { collation() { return this; }, lean: async () => ({ name: 'Newalt', reason: 'Trusted while pending' }) };
    });
    t.mock.method(Blacklist, 'updateOne', () => assert.fail('Blocked approval must not edit blacklist'));
    t.mock.method(Blacklist, 'create', () => assert.fail('Blocked approval must not create blacklist'));
    t.mock.method(oldModel, 'deleteOne', () => assert.fail('Blocked approval must preserve the source'));
    let closed = false;
    t.mock.method(PendingApproval, 'deleteOne', async () => { closed = true; });
    let response;
    await handleApprovedEditRequest({
      interaction: { editReply: async payload => { response = payload; } },
      payload: { existingEntryId: existing._id, currentType, type: 'black', scope: 'global', additionalNames: ['Newalt'] },
      requestId: 'pending',
      broadcastListChange: () => assert.fail('No broadcast on a blocked edit'),
      lang: 'en',
    });
    assert.match(JSON.stringify(trustedQuery), /Newalt/);
    assert.match(JSON.stringify(trustedQuery), /Originalalt/);
    assert.match(JSON.stringify(response.embeds[0].toJSON()), /Trusted while pending/);
    assert.equal(closed, true);
  });
}
