import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';
process.env.SENIOR_APPROVER_IDS = '';
process.env.OFFICER_APPROVER_IDS = '';

const { handleRosterCommand } = await import('../bot/handlers/roster/command.js');
const { handleSearchCommand } = await import('../bot/handlers/search/index.js');
const { createCheckHandlers } = await import('../bot/handlers/list/check/index.js');
const { bibleClient } = await import('../bot/services/roster/bibleClient.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');
const { clearUserLanguageCache, t } = await import('../bot/services/i18n/index.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: TrustedUser } = await import('../bot/models/TrustedUser.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function query(load) {
  return { collation() { return this; }, lean: load };
}
function interactionFor(events, { deep = false, mode = null } = {}) {
  const edits = [];
  return {
    edits,
    user: { id: 'latency-user' }, guild: { id: 'test-guild' },
    options: {
      getString: key => key === 'name' ? 'Alice' : key === 'mode' ? mode : null,
      getBoolean: () => deep,
      getInteger: () => null,
      getAttachment: () => ({ url: 'https://example.test/image.png' }),
    },
    deferReply: async payload => { events.push('ack'); return payload; },
    reply: async payload => { events.push('reply'); edits.push(payload); },
    editReply: async payload => { events.push('edit'); edits.push(payload); },
  };
}
function mockRoster(context, events, { language, snapshots = async () => [], failFetch = false } = {}) {
  clearUserLanguageCache();
  context.mock.method(UserPreference, 'findOne', () => query(async () => {
    events.push('language');
    return language ? language.promise : { language: 'en' };
  }));
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(RosterSnapshot, 'find', () => query(snapshots));
  context.mock.method(RosterSnapshot, 'bulkWrite', async () => { events.push('snapshot-write'); });
  for (const [Model, method, empty] of [[Blacklist, 'find', []], [Whitelist, 'findOne', null], [Watchlist, 'findOne', null], [TrustedUser, 'findOne', null]]) {
    context.mock.method(Model, method, () => query(async () => { events.push('list-read'); return empty; }));
  }
  context.mock.method(bibleClient, 'fetch', async () => {
    events.push('bible');
    if (failFetch) throw new Error('Bible unavailable');
    return { ok: true, text: async () => '<a href="/character/NA/Alice"><div class="text-lg font-semibold">Alice<span>1,790</span><span>6000</span></div></a>' };
  });
}

test('/la-roster acknowledges and starts Bible before an uncached language read settles', async context => {
  const events = [];
  const language = deferred();
  mockRoster(context, events, { language });
  const interaction = interactionFor(events);
  const running = handleRosterCommand(interaction);
  await turn();
  try {
    assert.equal(events[0], 'ack');
    assert.ok(events.includes('bible'), 'Bible work must overlap the locale query');
  } finally {
    language.resolve({ language: 'en' });
    await running;
  }
  assert.equal(interaction.edits.length, 1);
});

test('/la-roster reads list matches alongside old snapshots, then persists new stats', async context => {
  const events = [];
  const snapshotStarted = deferred();
  const snapshots = deferred();
  mockRoster(context, events, { snapshots: () => {
    events.push('snapshot-read');
    snapshotStarted.resolve();
    return snapshots.promise;
  } });
  const interaction = interactionFor(events);
  const running = handleRosterCommand(interaction);
  await snapshotStarted.promise;
  await turn();
  try {
    assert.equal(events.filter(event => event === 'list-read').length, 4);
    assert.ok(!events.includes('snapshot-write'), 'old values must be read before replacement');
  } finally {
    snapshots.resolve([{ name: 'Alice', itemLevel: 1780 }]);
    await running;
  }
  const description = interaction.edits[0].embeds.at(-1).toJSON().description;
  assert.ok(description.includes('(+10.00)'), 'the card must compare against the previous snapshot');
  assert.ok(events.includes('snapshot-write'));
});

test('/la-roster keeps denied deep scans away from Bible and snapshot writes', async context => {
  const events = [];
  mockRoster(context, events);
  const interaction = interactionFor(events, { deep: true });
  await handleRosterCommand(interaction);
  assert.ok(!events.includes('bible'));
  assert.ok(!events.includes('snapshot-write'));
  assert.equal(interaction.edits[0].flags, 64);
});

test('/la-roster refreshes snapshots even when a parallel list read fails', async context => {
  const events = [];
  mockRoster(context, events);
  context.mock.method(Watchlist, 'findOne', () => query(async () => { throw new Error('list unavailable'); }));
  const interaction = interactionFor(events);
  await handleRosterCommand(interaction);
  await turn();
  assert.ok(events.includes('snapshot-write'));
  assert.ok(interaction.edits[0].embeds[0].toJSON().fields[0].value.includes('list unavailable'));
});

test('/la-roster reports early Bible failures in the resolved user language', async context => {
  const events = [];
  const language = deferred();
  mockRoster(context, events, { language, failFetch: true });
  const interaction = interactionFor(events);
  const running = handleRosterCommand(interaction);
  await turn();
  language.resolve({ language: 'jp' });
  await running;
  assert.equal(interaction.edits[0].embeds[0].toJSON().description, t('dialogue.roster.fetchFailed', 'jp').description);
});

test('/la-search overlaps Bible with language lookup and keeps empty-result localization', async context => {
  const events = [];
  const language = deferred();
  clearUserLanguageCache();
  clearNameSuggestionCache();
  context.mock.method(UserPreference, 'findOne', () => query(() => language.promise));
  context.mock.method(bibleClient, 'fetch', async () => {
    events.push('bible');
    return { ok: true, status: 200, json: async () => ({ type: 'result', data: [[]] }) };
  });
  const interaction = interactionFor(events);
  const running = handleSearchCommand(interaction);
  await turn();
  try {
    assert.equal(events[0], 'ack');
    assert.ok(events.includes('bible'));
  } finally {
    language.resolve({ language: 'jp' });
    await running;
    clearNameSuggestionCache();
  }
  assert.equal(interaction.edits[0].embeds[0].toJSON().description, t('dialogue.search.noResults', 'jp', { name: 'Alice' }).description);
});

test('/la-check starts preference and OCR work while language is pending', async context => {
  const events = [];
  const language = deferred();
  clearUserLanguageCache();
  context.mock.method(UserPreference, 'findOne', () => query(() => language.promise));
  const { handleListCheckCommand } = createCheckHandlers({
    client: {},
    getUserOcrModeFn: async () => { events.push('mode'); return 'analysis'; },
    extractNamesFromImageFn: async (_image, options) => {
      events.push('ocr');
      assert.equal(options.mode, 'analysis');
      return [];
    },
  });
  const interaction = interactionFor(events);
  const running = handleListCheckCommand(interaction);
  await turn();
  try {
    assert.deepEqual(events.slice(0, 3), ['ack', 'mode', 'ocr']);
  } finally {
    language.resolve({ language: 'en' });
    await running;
  }
});

test('/la-check uses the resolved locale when OCR rejects before the locale query', async context => {
  const events = [];
  const language = deferred();
  clearUserLanguageCache();
  context.mock.method(UserPreference, 'findOne', () => query(() => language.promise));
  const { handleListCheckCommand } = createCheckHandlers({
    client: {},
    getUserOcrModeFn: () => assert.fail('an explicit mode must not load saved preferences'),
    extractNamesFromImageFn: async () => { throw new Error('OCR unavailable'); },
  });
  const interaction = interactionFor(events, { mode: 'daily' });
  const running = handleListCheckCommand(interaction);
  await turn();
  assert.equal(interaction.edits.length, 0);
  language.resolve({ language: 'jp' });
  await running;
  assert.equal(interaction.edits[0].embeds[0].toJSON().description, t('dialogue.check.ocrFailed', 'jp').description);
  assert.ok(interaction.edits[0].embeds[0].toJSON().fields[0].value.includes('OCR unavailable'));
});
