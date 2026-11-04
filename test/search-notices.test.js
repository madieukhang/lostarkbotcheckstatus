import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = '';
process.env.OFFICER_APPROVER_IDS = '';

const { handleSearchCommand } = await import('../bot/handlers/search/index.js');
const { createSearchDetailSelectHandler } = await import('../bot/handlers/search/evidence.js');
const { bibleClient } = await import('../bot/services/roster/bibleClient.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { COLORS } = await import('../bot/utils/ui.js');

function query(load) {
  return { collation() { return this; }, lean: load };
}

// lostark.bible's search table: slot 0 lists row pointers, each row is a
// triple of indexes into the same table for name, class and item level.
function bibleRows(rows) {
  const table = [[]];
  for (const [name, cls, itemLevel] of rows) {
    const row = table.length;
    table[0].push(row);
    table.push([row + 1, row + 2, row + 3], name, cls, itemLevel);
  }
  return { ok: true, status: 200, json: async () => ({ type: 'result', data: table }) };
}

function searchInteraction(name) {
  const edits = [];
  return {
    edits,
    user: { id: 'search-user' }, guild: { id: 'guild' },
    options: { getString: key => (key === 'name' ? name : null), getInteger: () => null },
    deferReply: async () => {},
    editReply: async payload => { edits.push(payload); },
  };
}

function mockVietnamese(context) {
  clearUserLanguageCache();
  clearNameSuggestionCache();
  context.mock.method(UserPreference, 'findOne', () => query(async () => ({ language: 'vi' })));
  context.after(() => { clearUserLanguageCache(); clearNameSuggestionCache(); });
}

test('search notices follow the B grammar: a filtered-empty result is an empty notice with its data', async context => {
  mockVietnamese(context);
  context.mock.method(bibleClient, 'fetch', async () => bibleRows([['Jinartist', 'bard', 1650], ['Jinbard', 'bard', 1600]]));
  const interaction = searchInteraction('Jinartist');

  await handleSearchCommand(interaction);

  const card = interaction.edits[0].embeds[0].toJSON();
  assert.equal(card.color, COLORS.info);
  assert.ok(card.title.startsWith('🔍  '), card.title);
  assert.match(card.description, /\*\*Jinartist\*\*/);
  assert.deepEqual(card.fields.map(({ name, value }) => [name, value]), [
    ['🎚️ Bộ lọc', 'ilvl ≥ 1700'],
    ['📋 Trước khi lọc', '2 character'],
  ]);
  assert.ok(card.footer.text.startsWith('💡 '), card.footer.text);
  assert.ok(card.timestamp);
});

test('search notices follow the B grammar: a failed search is a failure notice with the detail field', async context => {
  mockVietnamese(context);
  context.mock.method(bibleClient, 'fetch', async () => bibleRows([['Jinartist', 'bard', 1720]]));
  context.mock.method(mongoose, 'connect', async () => { throw new Error('Request timed out after 15000ms'); });
  const interaction = searchInteraction('Jinartist');

  await handleSearchCommand(interaction);

  const card = interaction.edits[0].embeds[0].toJSON();
  assert.equal(card.color, COLORS.danger);
  assert.ok(card.title.startsWith('❌  '), card.title);
  assert.match(card.description, /\*\*Jinartist\*\*/);
  assert.deepEqual(card.fields.map(({ name, value }) => [name, value]), [
    ['🧾 Chi tiết', '`Request timed out after 15000ms`'],
  ]);
  assert.ok(card.footer.text.startsWith('💡 '), card.footer.text);
});

function detailSelection(overrides = {}) {
  const payloads = [];
  return {
    payloads,
    user: { id: 'owner' },
    values: ['0'],
    reply: async payload => { payloads.push(payload); },
    deferReply: async () => {},
    editReply: async payload => { payloads.push(payload); },
    ...overrides,
  };
}

function detailHandler(deps = {}) {
  return createSearchDetailSelectHandler({
    interaction: { user: { id: 'owner' }, guild: { id: 'guild' }, client: {} },
    detailResults: [{ index: 0, result: { name: 'Jinartist' }, entry: { _id: 'entry' }, listType: 'black' }],
    lang: 'vi',
    getLanguage: async () => 'vi',
    loadStatMap: async () => new Map(),
    resolveImageUrl: async () => '',
    ...deps,
  });
}

const cardOf = selection => selection.payloads[0].embeds[0].toJSON();

test('search detail notices name their kind', async () => {
  const stranger = detailSelection({ user: { id: 'stranger' } });
  await detailHandler()(stranger);
  assert.ok(cardOf(stranger).title.startsWith('🔒  '), cardOf(stranger).title);
  assert.equal(cardOf(stranger).color, COLORS.warning);
  assert.ok(cardOf(stranger).footer.text.startsWith('💡 '));

  const stale = detailSelection({ values: ['9'] });
  await detailHandler()(stale);
  assert.ok(cardOf(stale).title.startsWith('⌛  '), cardOf(stale).title);
  assert.equal(cardOf(stale).color, COLORS.muted);

  const removed = detailSelection();
  await detailHandler({ loadEntry: async () => null })(removed);
  assert.ok(cardOf(removed).title.startsWith('⌛  '), cardOf(removed).title);
  assert.equal(cardOf(removed).color, COLORS.muted);

  const broken = detailSelection();
  await detailHandler({ loadEntry: async () => { throw new Error('boom'); } })(broken);
  assert.ok(cardOf(broken).title.startsWith('❌  '), cardOf(broken).title);
  assert.equal(cardOf(broken).color, COLORS.danger);
  assert.match(cardOf(broken).description, /\*\*Jinartist\*\*/);
  assert.deepEqual(cardOf(broken).fields.map(({ name, value }) => [name, value]), [['🧾 Chi tiết', '`boom`']]);
});
