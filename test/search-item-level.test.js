import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

const { handleSearchCommand } = await import('../bot/handlers/search/index.js');
const { bibleClient } = await import('../bot/services/roster/bibleClient.js');
const { clearNameSuggestionCache } = await import('../bot/services/roster/search.js');
const { clearUserLanguageCache } = await import('../bot/services/i18n/index.js');
const { default: UserPreference } = await import('../bot/models/UserPreference.js');
const { default: RosterSnapshot } = await import('../bot/models/RosterSnapshot.js');
const { default: Blacklist } = await import('../bot/models/Blacklist.js');
const { default: Whitelist } = await import('../bot/models/Whitelist.js');
const { default: Watchlist } = await import('../bot/models/Watchlist.js');
const { default: TrustedUser } = await import('../bot/models/TrustedUser.js');

const query = (rows) => ({ collation() { return this; }, lean: async () => rows });

async function searchShawlion(context, { searchLevel, snapshotLevel }) {
  clearUserLanguageCache();
  clearNameSuggestionCache();
  context.after(clearNameSuggestionCache);
  context.mock.method(mongoose, 'connect', async () => mongoose);
  context.mock.method(UserPreference, 'findOne', () => query({ language: 'en' }));
  context.mock.method(RosterSnapshot, 'find', () => query([
    { name: 'Shawlion', classId: 'holyknight', itemLevel: snapshotLevel, combatScore: '4100' },
  ]));
  for (const Model of [Blacklist, Whitelist, Watchlist, TrustedUser]) {
    context.mock.method(Model, 'find', () => query([]));
    context.mock.method(Model, 'findOne', () => query(null));
  }
  context.mock.method(bibleClient, 'fetch', async () => Response.json({
    type: 'result',
    result: JSON.stringify([[1], [2, 3, 4], 'Shawlion', 'holyknight', searchLevel]),
  }));
  const edits = [];
  await handleSearchCommand({
    user: { id: 'search-user' },
    guild: { id: 'test-guild' },
    options: { getString: (key) => (key === 'name' ? 'Shawlion' : null), getInteger: () => null },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });
  return JSON.stringify(edits.at(-1).embeds[0].toJSON());
}

// A live Bible search can be newer than the stored snapshot, and a snapshot
// can be newer than Bible's search index, so the card shows the higher level.
for (const [label, searchLevel, snapshotLevel] of [
  ['a live search newer than the snapshot', 1755, 1725],
  ['a snapshot newer than the search index', 1725, 1755],
]) {
  test(`/la-search shows the higher item level for ${label}`, async (context) => {
    const shown = await searchShawlion(context, { searchLevel, snapshotLevel });
    assert.match(shown, /1,?755/);
    assert.doesNotMatch(shown, /1,?725/);
  });
}
