import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import UserPreference from '../bot/models/UserPreference.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { buildScopedListQuery } from '../bot/utils/scope.js';
import { handleListEvidenceAutocomplete } from '../bot/handlers/list/evidence/command.js';
import { buildEntryChoices } from '../bot/handlers/list/services/entrySuggestions.js';
import { createAutocompleteRoutes } from '../bot/app/interaction-router.js';
import { buildCommands } from '../bot/commands/index.js';

const GUILD = 'suggest-guild';

// Each list answers `docs[type]`, the roster snapshots `docs.snapshots`;
// `queries[type]` records what each was asked.
function stubLists(t, docs) {
  clearUserLanguageCache();
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  const queries = {};
  for (const [type, model] of [['black', Blacklist], ['white', Whitelist], ['watch', Watchlist], ['snapshots', RosterSnapshot]]) {
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

test('suggestions show the list icon, the class before the name and a server tag, valued by list and id', async (t) => {
  const queries = stubLists(t, {
    black: [{ _id: 'b1', name: 'Mokoko', scope: 'server', raid: 'Serca Hard', reason: 'Left mid-raid' }],
    white: [{ _id: 'w1', name: 'Mokobear', reason: '' }],
    // Snapshot names match case-insensitively; Mokobear has none, so no class or CP.
    snapshots: [{ name: 'mokoko', classId: 'bard', combatScore: '2,345.6' }],
  });

  const choices = await suggest({ name: 'name', value: ' mok ' });

  assert.deepEqual(choices, [
    { name: '⛔ Bard · Mokoko [S] · CP 2,345.6', value: 'black:b1' },
    { name: '✅ Mokobear', value: 'white:w1' },
  ]);
  const prefix = { name: /^mok/i };
  assert.deepEqual(queries.black, buildScopedListQuery('black', prefix, GUILD));
  assert.deepEqual(queries.white, prefix);
  assert.deepEqual(queries.watch, prefix);
  assert.deepEqual(queries.snapshots, { name: { $in: ['Mokoko', 'Mokobear'] } });
});

test('a class with an icon shows the icon in place of its name, and an unknown CP stays out', async (t) => {
  // Class icons are application emoji loaded at runtime; seed one for Bard.
  const previous = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = '<:bard:1>';
  t.after(() => { CLASS_EMOJI_MAP.Bard = previous; });
  stubLists(t, { black: [{ _id: 'b1', name: 'Mokoko', reason: 'r' }], snapshots: [{ name: 'Mokoko', classId: 'bard', combatScore: '?' }] });

  assert.deepEqual(await suggest({ name: 'name', value: 'mok' }), [{ name: '⛔ <:bard:1> Mokoko', value: 'black:b1' }]);
});

test('suggestions leave the class out when the class lookup fails', async (t) => {
  stubLists(t, { black: [{ _id: 'b1', name: 'Mokoko', reason: 'r' }], snapshots: new Error('db busy') });
  assert.deepEqual(await suggest({ name: 'name', value: 'mok' }), [{ name: '⛔ Mokoko', value: 'black:b1' }]);
});

test('evidence suggestions match the typed text literally and list recent entries when nothing is typed', async (t) => {
  const queries = stubLists(t, {});
  await suggest({ name: 'name', value: 'a.b(' });
  assert.equal(queries.white.name.source, '^a\\.b\\(');
  await suggest({ name: 'name', value: '  ' });
  assert.deepEqual(queries.white, {});
});

test('with nothing typed, suggestions are the 10 newest entries across the lists', async (t) => {
  const at = (day) => new Date(Date.UTC(2026, 10, day));
  const entries = (prefix, days) => days.map((day) => ({ _id: `${prefix}${day}`, name: `N${prefix}${day}`, reason: 'r', addedAt: at(day) }));
  stubLists(t, { black: entries('b', [20, 14, 9, 3]), white: entries('w', [19, 12, 8, 2]), watch: entries('t', [18, 11, 7, 1]) });

  const choices = await listSuggest('remove', { name: 'name', value: '' });

  assert.deepEqual(choices.map((choice) => choice.value), ['Nb20', 'Nw19', 'Nt18', 'Nb14', 'Nw12', 'Nt11', 'Nb9', 'Nw8', 'Nt7', 'Nb3']);
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
  assert.deepEqual(buildEntryChoices(results, ({ doc }) => doc.name), [{ name: '⛔ Mokoko', value: 'Mokoko' }]);
  assert.equal(buildEntryChoices(results, ({ type, doc }) => `${type}:${doc._id}`).length, 2);
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
