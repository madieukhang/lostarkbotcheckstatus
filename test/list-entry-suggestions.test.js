import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache, t as translate } from '../bot/services/i18n/index.js';
import { buildScopedListQuery } from '../bot/utils/scope.js';
import { handleListEvidenceAutocomplete } from '../bot/handlers/list/evidence/command.js';
import { buildEntryChoices } from '../bot/handlers/list/services/entrySuggestions.js';
import { createAutocompleteRoutes } from '../bot/app/interaction-router.js';
import { buildCommands } from '../bot/commands/index.js';

const GUILD = 'suggest-guild';

// Each list answers `docs[type]`; `queries[type]` records what it was asked.
function stubLists(t, docs) {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const queries = {};
  for (const [type, model] of [['black', Blacklist], ['white', Whitelist], ['watch', Watchlist]]) {
    t.mock.method(model, 'find', (query) => {
      queries[type] = query;
      const chain = { collation: () => chain, sort: () => chain, limit: () => chain, lean: async () => docs[type] ?? [] };
      if (docs[type] instanceof Error) chain.lean = async () => { throw docs[type]; };
      return chain;
    });
  }
  return queries;
}

async function suggest(focused) {
  let answered = null;
  await handleListEvidenceAutocomplete({
    user: { id: 'viewer' },
    guild: { id: GUILD },
    options: { getFocused: () => focused },
    respond: async (choices) => { answered = choices; },
  });
  return answered;
}

test('evidence suggestions show the list icon, a server tag and the reason, valued by list and id', async (t) => {
  const queries = stubLists(t, {
    black: [{ _id: 'b1', name: 'Mokoko', scope: 'server', reason: 'Left mid-raid' }],
    white: [{ _id: 'w1', name: 'Mokobear', reason: '' }],
  });

  const choices = await suggest({ name: 'name', value: ' mok ' });

  assert.deepEqual(choices, [
    { name: '⛔ Mokoko [S] - Left mid-raid', value: 'black:b1' },
    { name: `✅ Mokobear - ${translate('listView.navigation.noReason', 'en')}`, value: 'white:w1' },
  ]);
  const prefix = { name: /^mok/i };
  assert.deepEqual(queries.black, buildScopedListQuery('black', prefix, GUILD));
  assert.deepEqual(queries.white, prefix);
  assert.deepEqual(queries.watch, prefix);
});

test('evidence suggestions match the typed text literally and list recent entries when nothing is typed', async (t) => {
  const queries = stubLists(t, {});
  await suggest({ name: 'name', value: 'a.b(' });
  assert.equal(queries.white.name.source, '^a\\.b\\(');
  await suggest({ name: 'name', value: '  ' });
  assert.deepEqual(queries.white, {});
});

test('evidence suggestions stop at 25 and show an entry once', async (t) => {
  const many = (prefix, count) => Array.from({ length: count }, (_, i) => ({ _id: `${prefix}${i}`, name: `N${prefix}${i}`, reason: 'r' }));
  stubLists(t, { black: [...many('b', 20), { _id: 'b0', name: 'Nb0', reason: 'r' }], white: many('w', 10) });

  const choices = await suggest({ name: 'name', value: 'n' });

  assert.equal(choices.length, 25);
  assert.equal(new Set(choices.map((choice) => choice.value)).size, 25);
});

test('name-valued choices show a name found in two lists once', () => {
  const results = [
    { type: 'black', doc: { _id: 'b1', name: 'Mokoko', reason: 'r' } },
    { type: 'white', doc: { _id: 'w1', name: 'Mokoko', reason: 'r' } },
  ];
  assert.deepEqual(buildEntryChoices(results, 'en', ({ doc }) => doc.name), [{ name: '⛔ Mokoko - r', value: 'Mokoko' }]);
  assert.equal(buildEntryChoices(results, 'en', ({ type, doc }) => `${type}:${doc._id}`).length, 2);
});

test('evidence suggestions answer empty for another option', async (t) => {
  stubLists(t, { white: [{ _id: 'w1', name: 'Xavier', reason: 'r' }] });
  assert.deepEqual(await suggest({ name: 'public', value: 'x' }), []);
});

test('evidence suggestions answer empty when the lookup fails', async (t) => {
  stubLists(t, { white: new Error('db down') });
  assert.deepEqual(await suggest({ name: 'name', value: 'x' }), []);
});

// The /la-list autocomplete answer for a focused option under a subcommand.
async function listSuggest(subcommand, focused) {
  let answered = null;
  await createAutocompleteRoutes()['la-list']({
    user: { id: 'viewer' },
    guild: { id: GUILD },
    options: { getFocused: () => focused, getSubcommand: () => subcommand, getString: () => null },
    respond: async (choices) => { answered = choices; },
  });
  return answered;
}

test('/la-list edit, remove and edit-form suggest entry names; add does not', async (t) => {
  stubLists(t, {
    black: [{ _id: 'b1', name: 'Mokoko', scope: 'global', reason: 'Left mid-raid' }],
    white: [{ _id: 'w1', name: 'Mokoko', reason: 'Carried' }, { _id: 'w2', name: 'Mokobear', reason: 'r' }],
  });
  for (const subcommand of ['edit', 'remove', 'edit-form']) {
    const choices = await listSuggest(subcommand, { name: 'name', value: 'mok' });
    assert.deepEqual(choices.map((choice) => choice.value), ['Mokoko', 'Mokobear'], subcommand);
  }
  assert.deepEqual(await listSuggest('add', { name: 'name', value: 'mok' }), []);
});

test('/la-list name suggestions answer empty when the lookup fails, and raid suggestions stay', async (t) => {
  stubLists(t, { black: new Error('db down') });
  assert.deepEqual(await listSuggest('edit', { name: 'name', value: 'mok' }), []);
  const raids = await listSuggest('add', { name: 'raid', value: 'serca' });
  assert.ok(raids.some((choice) => choice.value === 'Serca Hard'));
});

test('the name option searches in edit, remove and edit-form, where it is optional', () => {
  const list = buildCommands().find((command) => command.name === 'la-list');
  const nameOf = (sub) => list.options.find((option) => option.name === sub).options.find((option) => option.name === 'name');
  for (const sub of ['edit', 'remove', 'edit-form']) assert.equal(nameOf(sub).autocomplete, true, sub);
  assert.ok(!nameOf('add').autocomplete);
  assert.ok(!nameOf('edit-form').required);
});
