import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import config from '../bot/config.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import { createTrustHandlers } from '../bot/handlers/list/trust/index.js';
import { bibleClient } from '../bot/services/roster/bibleClient.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';

// Refreshing a trusted user replaces its roster only with one lostark.bible
// actually listed; an outage or a hidden roster keeps the confirmed alts.
let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('trust_refresh'));
  await TrustedUser.init();
});
test.after(async () => { await disconnectDB(); await mongo?.stop(); });

async function refreshTrust(t, { name, stored, reason = null, bible }) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external I/O'); });
  t.mock.method(bibleClient, 'fetch', async url => bible(String(url)));
  const officerId = 'trust-refresh-officer';
  config.officerApproverIds.push(officerId);
  t.after(() => { config.officerApproverIds.splice(config.officerApproverIds.indexOf(officerId), 1); });
  clearUserLanguageCache();
  const before = await TrustedUser.create({
    name, allCharacters: stored, reason: 'Approved trust',
    enrichmentSource: 'bible', enrichedAt: new Date('2026-10-10T00:00:00Z'),
  });
  const edits = [];
  const values = { action: 'add', name, reason };
  const interaction = {
    user: { id: officerId, tag: 'officer' }, guild: { id: 'guild' },
    options: { getString: key => values[key] ?? null },
    deferReply: async () => {},
    editReply: async payload => { edits.push(payload); },
  };
  await createTrustHandlers().handleListTrustCommand(interaction);
  return { after: await TrustedUser.findById(before._id).lean(), reply: JSON.stringify(edits.at(-1)) };
}

test('a refresh while lostark.bible is down keeps the stored alts and still saves the new reason', async t => {
  const { after, reply } = await refreshTrust(t, {
    name: 'Trustdown', stored: ['Trustdown', 'Trustdownalt'], reason: 'Still trusted',
    bible: () => new Response('Temporarily unavailable', { status: 503 }),
  });
  assert.deepEqual(after.allCharacters, ['Trustdown', 'Trustdownalt']);
  assert.equal(after.enrichmentSource, 'bible');
  assert.equal(after.reason, 'Still trusted');
  assert.match(reply, /Roster not refreshed/);
});

test('a refresh that finds the roster hidden keeps the stored alts', async t => {
  const { after, reply } = await refreshTrust(t, {
    name: 'Trusthidden', stored: ['Trusthidden', 'Trusthiddenalt'],
    bible: url => {
      if (url.endsWith('/roster')) return new Response('<html><body><h1>Hidden roster</h1></body></html>');
      if (url.endsWith('/__data.json')) return new Response('not-json');
      return new Response('class:"bard",itemLevel:1723.33,world:"Thaemine",rosterLevel:300,guild:{name:"G",grade:"Member"}');
    },
  });
  assert.deepEqual(after.allCharacters, ['Trusthidden', 'Trusthiddenalt']);
  assert.equal(after.reason, 'Approved trust');
  assert.match(reply, /Roster not refreshed/);
});

test('a refresh with a listed roster still replaces the stored alts', async t => {
  const { after } = await refreshTrust(t, {
    name: 'Trustlisted', stored: ['Trustlisted', 'Trustlistedold'],
    bible: () => new Response(
      '<a href="/character/NA/Trustlisted"><div class="text-lg font-semibold">Trustlisted<span>1750</span><span>100</span></div></a>'
      + '<a href="/character/NA/Trustlistednew"><div class="text-lg font-semibold">Trustlistednew<span>1700</span><span>90</span></div></a>'
    ),
  });
  assert.deepEqual([...after.allCharacters].sort(), ['Trustlisted', 'Trustlistednew']);
  assert.equal(after.enrichmentSource, 'bible');
});
