import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const {
  getSearchDetailResults,
  buildSearchDetailComponents,
  createSearchDetailSelectHandler,
  loadSearchDetailEntry,
} = await import('../bot/handlers/search/evidence.js');
const { buildScopedListQuery } = await import('../bot/utils/scope.js');
const { t } = await import('../bot/services/i18n/index.js');

const entry = { _id: 'a'.repeat(24), name: 'Burgerxúcxích', reason: 'vua ngủ gật', allCharacters: ['Hailúa', 'Burgerxúcxích'] };

test('search details include every report type without images and keep each search alias reachable', () => {
  const results = [
    { name: 'Unlisted' },
    { name: 'Black', black: entry },
    { name: 'Hailúa', watch: entry },
    { name: 'Otheralt', watch: entry },
    { name: 'White', white: entry },
    { name: 'Trusted', trusted: entry },
  ];
  const details = getSearchDetailResults(results);
  assert.deepEqual(details.map(detail => detail.index), [1, 2, 3, 4]);
  for (const lang of ['vi', 'en', 'jp']) {
    const [row] = buildSearchDetailComponents(details, lang);
    const select = row.toJSON().components[0];
    assert.equal(select.custom_id, 'search_evidence');
    assert.ok(select.placeholder.includes(t('listView.navigation.detailsPlaceholder', lang)));
    assert.deepEqual(select.options.map(option => option.value), ['1', '2', '3', '4', 'none']);
    assert.deepEqual(select.options.slice(0, -1).map(option => option.label), ['Black', 'Hailúa', 'Otheralt', 'White']);
    assert.deepEqual(select.options.slice(0, -1).map(option => option.emoji.name), ['⛔', '⚠️', '⚠️', '✅']);
    assert.equal(select.options.at(-1).label, t('listView.navigation.selectNone', lang));
  }
  assert.deepEqual(buildSearchDetailComponents([]), []);
});

test('search detail reload keeps blacklist guild scope and uses the stored entry identity', async () => {
  for (const listType of ['black', 'watch', 'white']) {
    let received;
    const loaded = await loadSearchDetailEntry({ entry, listType }, 'guild-1', {
      getContext(type) {
        assert.equal(type, listType);
        return { model: { findOne(query) { received = query; return { lean: async () => entry }; } } };
      },
    });
    assert.equal(loaded, entry);
    assert.deepEqual(received, buildScopedListQuery(listType, { _id: entry._id }, 'guild-1'));
  }
});

function makeInteraction(userId = 'owner', value = '0') {
  const calls = [];
  return {
    calls, user: { id: userId }, values: [value],
    async deferReply(payload) { calls.push({ kind: 'defer', payload }); },
    async editReply(payload) { calls.push({ kind: 'edit', payload }); },
    async reply(payload) { calls.push({ kind: 'reply', payload }); },
  };
}

function makeHandler(overrides = {}) {
  return createSearchDetailSelectHandler({
    interaction: { user: { id: 'owner' }, guildId: 'guild-1', client: {} },
    detailResults: getSearchDetailResults([{ name: 'Hailúa', watch: entry }]),
    lang: 'vi',
    loadEntry: async () => entry,
    loadStatMap: async () => new Map(),
    resolveImageUrl: async () => { throw new Error('image lookup must not run without an image'); },
    ...overrides,
  });
}

test('search reset preserves other controls, performs no reads and permits selecting the same report again', async () => {
  let reads = 0;
  const handler = makeHandler({ loadEntry: async () => { reads += 1; return entry; } });
  const rows = buildSearchDetailComponents(getSearchDetailResults([{ name: 'Hailúa', watch: entry }]), 'vi');
  const otherRow = { type: 1, components: [{ type: 2, custom_id: 'unrelated', label: 'Keep', style: 2 }] };
  let reset;
  await handler({
    user: { id: 'owner' }, values: ['none'], message: { components: [...rows, otherRow] },
    update: async payload => { reset = payload; },
  });
  assert.equal(reads, 0);
  assert.deepEqual(reset.components.at(-1), otherRow);
  assert.ok(reset.components[0].components[0].options.every(option => !option.default));
  await handler(makeInteraction());
  assert.equal(reads, 1);
});

test('search reserves one reset option within the Discord limit', () => {
  const details = Array.from({ length: 30 }, (_, index) => ({ index, entry, listType: 'black', result: { name: `Char${index}` } }));
  const select = buildSearchDetailComponents(details)[0].toJSON().components[0];
  assert.equal(select.options.length, 25);
  assert.equal(select.options.at(-1).value, 'none');
});

test('search detail opens a fresh report without an image and preserves its primary name', async () => {
  const selected = makeInteraction();
  const fresh = { ...entry, reason: 'Updated report' };
  await makeHandler({
    loadEntry: async (detail, guildId) => {
      assert.equal(selected.calls[0].kind, 'defer', 'acknowledge before I/O');
      assert.equal(guildId, 'guild-1');
      assert.equal(detail.result.name, 'Hailúa');
      return fresh;
    },
    loadStatMap: async (loaded) => {
      assert.equal(loaded, fresh);
      return new Map([['burgerxúcxích', { itemLevel: 1730, className: 'Breaker', combatScore: '≈4112.08' }]]);
    },
  })(selected);
  assert.equal(selected.calls[0].payload.flags, MessageFlags.Ephemeral);
  const card = selected.calls[1].payload.embeds[0].toJSON();
  assert.match(card.title, /Kết quả kiểm tra.*Watchlist/u);
  assert.match(card.description, /Burgerxúcxích/u);
  assert.ok(card.fields.some(field => field.value === 'Updated report'));
  assert.ok(card.fields.some(field => field.value === '`1730.00`'));
  assert.equal(card.image, undefined);
  assert.equal(entry.name, 'Burgerxúcxích');
});

test('search details preserve the report when its stored evidence is unavailable', async () => {
  const selected = makeInteraction();
  await makeHandler({
    loadEntry: async () => ({ ...entry, imageMessageId: 'gone' }),
    resolveImageUrl: async () => null,
  })(selected);
  const card = selected.calls[1].payload.embeds[0].toJSON();
  assert.ok(card.fields.some(field => field.value === entry.reason));
  assert.ok(card.fields.some(field => field.value === t('listView.evidence.unavailable', 'vi')));
  assert.equal(card.image, undefined);
});

test('search details attach available evidence to the shared detail card', async () => {
  const selected = makeInteraction();
  const url = 'https://example.test/evidence.png';
  await makeHandler({
    loadEntry: async () => ({ ...entry, imageMessageId: 'exists' }),
    resolveImageUrl: async () => url,
  })(selected);
  assert.equal(selected.calls[1].payload.embeds[0].toJSON().image.url, url);
});

test('search detail actions reject another user or a malformed result index before reading records', async () => {
  for (const [userId, value] of [['someone-else', '0'], ['owner', '0junk'], ['owner', '-1']]) {
    const selected = makeInteraction(userId, value);
    let reads = 0;
    await makeHandler({
      loadEntry: async () => { reads++; return entry; },
      getLanguage: async () => 'en',
    })(selected);
    assert.equal(reads, 0);
    assert.equal(selected.calls.at(-1).kind, userId === 'owner' ? 'edit' : 'reply');
  }
});

test('search detail actions show a removed-entry notice instead of a stale report', async () => {
  const selected = makeInteraction();
  await makeHandler({ loadEntry: async () => null })(selected);
  const card = selected.calls[1].payload.embeds[0].toJSON();
  assert.equal(card.description, t('dialogue.check.entryRemoved', 'vi').description);
  assert.ok(!card.fields?.some(field => field.value === entry.reason));
});
