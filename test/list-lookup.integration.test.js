import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import { loadListLookup } from '../bot/services/list-check/lookup.js';

let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Blacklist, Whitelist, Watchlist, TrustedUser].map(model => model.init()));
});
test.after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test.beforeEach(async () => {
  await Promise.all([Blacklist, Whitelist, Watchlist, TrustedUser].map(model => model.deleteMany({})));
});

test('bulk checks omit report histories while retaining identity, latest report and evidence metadata', async () => {
  const report = {
    name: 'Target', allCharacters: ['Target', 'Alias'], reason: 'Latest report', raid: 'Kazeros Hard',
    imageMessageId: 'evidence-message', imageChannelId: 'archive', logsUrl: 'https://lostark.bible/logs/ABC',
    notes: Array.from({ length: 1200 }, (_, index) => ({ reason: `${index}: ${'x'.repeat(900)}`, raid: 'Kazeros Hard' })),
  };
  await Promise.all([Blacklist, Whitelist, Watchlist].map(model => model.create(report)));
  await TrustedUser.create({ name: 'Target', allCharacters: ['Target', 'Alias'], reason: 'Trusted roster' });

  const { maps } = await loadListLookup(['ALIAS'], { guildId: 'current' });
  for (const listType of ['black', 'white', 'watch']) {
    const entry = maps[listType].get('alias');
    assert.equal(Object.hasOwn(entry, 'notes'), false, `${listType} does not load history for a summary lookup`);
    assert.equal(entry.name, report.name);
    assert.deepEqual(entry.allCharacters, report.allCharacters);
    assert.equal(entry.reason, report.reason);
    assert.equal(entry.raid, report.raid);
    assert.equal(entry.imageMessageId, report.imageMessageId);
    assert.equal(entry.imageChannelId, report.imageChannelId);
    assert.equal(entry.logsUrl, report.logsUrl);
    assert.ok(entry._id);
  }
  assert.equal(maps.trusted.get('alias').reason, 'Trusted roster');
  const fullEntry = await Blacklist.findById(maps.black.get('alias')._id).lean();
  assert.equal(fullEntry.notes.length, report.notes.length, 'the detail read still returns the complete stored history');
});

test('summary projection keeps current-server precedence and hides another server report', async () => {
  const global = await Blacklist.create({ name: 'Target', allCharacters: ['Alias'], reason: 'Global report' });
  const local = await Blacklist.create({ name: 'Target', allCharacters: ['Alias'], scope: 'server', guildId: 'current', reason: 'Local report' });
  await Blacklist.create({ name: 'Hidden', allCharacters: ['Alias'], scope: 'server', guildId: 'other', reason: 'Hidden report' });

  const { maps } = await loadListLookup(['Alias'], { guildId: 'current' });
  assert.equal(String(maps.black.get('alias')._id), String(local._id));
  assert.equal(maps.black.has('hidden'), false);
  const external = await loadListLookup(['Alias'], { guildId: 'external' });
  assert.equal(String(external.maps.black.get('alias')._id), String(global._id));
});
