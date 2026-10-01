import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Blacklist from '../bot/models/Blacklist.js';
import UserPreference from '../bot/models/UserPreference.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { buildNoteHistoryPayload } from '../bot/handlers/list/notes/historyView.js';
import { createNoteHandlers } from '../bot/handlers/list/notes/index.js';

const day = n => new Date(Date.UTC(2026, 6, n));
const note = (n, reason, extra = {}) => ({ at: day(n), reason, raid: 'Kazeros Hard', byUserId: `u${n}`, byName: `Reporter${n}`, ...extra });
const entryWith = (notes, extra = {}) => ({ _id: 'b'.repeat(24), name: 'Lovesiiii', scope: 'global', notes, ...extra });

test('three notes read oldest first, the original marked 🌱 and the last as latest, each with its writer', () => {
  const { embeds, components } = buildNoteHistoryPayload({
    entry: entryWith([note(2, 'Đánh quá yếu', { raid: 'Act4 Nor' }), note(14, 'afk G1'), note(30, 'vẫn thế', { raid: '' })]),
    type: 'black', page: 1, lang: 'en',
  });
  const embed = embeds[0].toJSON();
  assert.equal(embed.title, '📜 Note history · Lovesiiii');
  assert.match(embed.description, /\*\*3\*\* notes, oldest first/);
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [
    ['🌱 02 Jul 2026 · Act4 Nor', 'Đánh quá yếu\n-# Original note · by Reporter2'],
    ['📝 14 Jul 2026 · Kazeros Hard', 'afk G1\n-# by Reporter14'],
    ['📝 30 Jul 2026', 'vẫn thế\n-# Latest · by Reporter30'],
  ]);
  assert.equal(embed.footer.text, 'Only you can see this');
  assert.deepEqual(components, []);
});

test('an entry saved before notes shows its add as the only note, and a missing date reads N/A', () => {
  const entry = { _id: 'c'.repeat(24), name: 'Old', reason: 'Legacy', raid: '', addedByDisplayName: 'KilZ' };
  const embed = buildNoteHistoryPayload({ entry, type: 'white', page: 1, lang: 'en' }).embeds[0].toJSON();
  assert.deepEqual(embed.fields.map(field => [field.name, field.value]), [['🌱 N/A', 'Legacy\n-# Original note · by KilZ']]);
});

test('twelve notes page at ten, and the last page disables Next', () => {
  const notes = Array.from({ length: 12 }, (_, i) => note(i + 1, `report ${i + 1}`));
  const first = buildNoteHistoryPayload({ entry: entryWith(notes), type: 'black', page: 1, lang: 'en' });
  assert.equal(first.embeds[0].toJSON().fields.length, 10);
  const last = buildNoteHistoryPayload({ entry: entryWith(notes), type: 'black', page: 9, lang: 'en' });
  const embed = last.embeds[0].toJSON();
  assert.equal(embed.fields.length, 2, 'a page past the end clamps to the last page');
  assert.equal(embed.footer.text, 'Page 2/2 · only you can see this');
  const [previous, next] = last.components[0].toJSON().components;
  assert.equal(previous.custom_id, `listnote_page:black:${'b'.repeat(24)}:1`);
  assert.equal(previous.disabled, false);
  assert.equal(next.disabled, true);
});

test('long notes break the page early so every card stays under the Discord limit', () => {
  const notes = Array.from({ length: 10 }, (_, i) => note(i + 1, 'x'.repeat(1500)));
  const pages = [];
  for (let page = 1; page <= 10; page += 1) {
    const payload = buildNoteHistoryPayload({ entry: entryWith(notes), type: 'black', page, lang: 'en' });
    pages.push(payload.embeds[0]);
    if (payload.components.length === 0 || payload.components[0].toJSON().components[1].disabled) break;
  }
  assert.ok(pages.length > 1);
  assert.ok(pages.every(embed => embed.length <= 6000));
  assert.ok(pages.every(embed => embed.toJSON().fields.every(field => field.value.length <= 1024)));
  assert.equal(pages.reduce((sum, embed) => sum + embed.toJSON().fields.length, 0), 10);
});

function mockLanguage(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

function buttonInteraction(customId, guildId = 'guild') {
  const calls = { deferred: 0, updated: 0, edits: [] };
  return {
    calls,
    interaction: {
      customId, guildId, guild: guildId ? { id: guildId } : null, user: { id: 'viewer' },
      deferReply: async () => { calls.deferred += 1; },
      deferUpdate: async () => { calls.updated += 1; },
      editReply: async payload => calls.edits.push(payload),
    },
  };
}

test('the History button opens an ephemeral card scoped like the check details', async t => {
  mockLanguage(t);
  const queries = [];
  const entry = entryWith([note(2, 'one'), note(3, 'two')]);
  t.mock.method(Blacklist, 'findOne', query => { queries.push(query); return { lean: async () => entry }; });
  const { handleListNoteHistoryButton } = createNoteHandlers({ services: {} });
  const { calls, interaction } = buttonInteraction(`listnote_history:black:${entry._id}:1`);
  await handleListNoteHistoryButton(interaction);
  assert.equal(calls.deferred, 1);
  assert.match(JSON.stringify(queries[0]), /guild/);
  assert.equal(calls.edits[0].embeds[0].toJSON().title, '📜 Note history · Lovesiiii');
});

test('an entry hidden from this server or removed answers with the removed notice', async t => {
  mockLanguage(t);
  t.mock.method(Blacklist, 'findOne', () => ({ lean: async () => null }));
  const { handleListNoteHistoryButton } = createNoteHandlers({ services: {} });
  const { calls, interaction } = buttonInteraction(`listnote_history:black:${'b'.repeat(24)}:1`, null);
  await handleListNoteHistoryButton(interaction);
  assert.doesNotMatch(JSON.stringify(calls.edits[0]), /Note history/);
  assert.equal(calls.edits[0].embeds.length, 1);
});

test('the page buttons edit the history card in place', async t => {
  mockLanguage(t);
  const entry = entryWith(Array.from({ length: 12 }, (_, i) => note(i + 1, `report ${i + 1}`)));
  t.mock.method(Blacklist, 'findOne', () => ({ lean: async () => entry }));
  const { handleListNotePageButton } = createNoteHandlers({ services: {} });
  const { calls, interaction } = buttonInteraction(`listnote_page:black:${entry._id}:2`);
  await handleListNotePageButton(interaction);
  assert.equal(calls.updated, 1);
  assert.equal(calls.deferred, 0);
  assert.equal(calls.edits[0].embeds[0].toJSON().footer.text, 'Page 2/2 · only you can see this');
});
