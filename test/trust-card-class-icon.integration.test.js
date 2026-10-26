import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import config from '../bot/config.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import { createTrustHandlers } from '../bot/handlers/list/trust/index.js';
import { bibleClient } from '../bot/services/roster/bibleClient.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';

// The Trusted cards name the character with its class icon, like the list
// cards. Class emoji are bootstrapped at runtime, so the class name stands in.
let mongo;
test.before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('trust_class_icon'));
  await TrustedUser.init();
});
test.after(async () => { await disconnectDB(); await mongo?.stop(); });

async function runTrust(t, values, bible = () => { throw new Error('Unexpected lostark.bible call'); }) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external I/O'); });
  t.mock.method(bibleClient, 'fetch', async (url) => bible(String(url)));
  const officerId = 'trust-class-officer';
  config.officerApproverIds.push(officerId);
  t.after(() => { config.officerApproverIds.splice(config.officerApproverIds.indexOf(officerId), 1); });
  clearUserLanguageCache();
  const edits = [];
  await createTrustHandlers().handleListTrustCommand({
    user: { id: officerId, tag: 'officer' }, guild: { id: 'guild' },
    options: { getString: (key) => values[key] ?? null },
    deferReply: async () => {},
    editReply: async (payload) => { edits.push(payload); },
  });
  return edits.at(-1).embeds[0].toJSON();
}

test('removing a trusted user shows its class from the roster snapshot', async (t) => {
  await TrustedUser.create({ name: 'Trustgone', allCharacters: ['Trustgone'], reason: 'Old friend' });
  await RosterSnapshot.create({ name: 'Trustgone', classId: 'berserker', itemLevel: 1750 });

  const embed = await runTrust(t, { action: 'remove', name: 'Trustgone' });

  assert.ok(embed.fields[0].value.startsWith('Berserker [Trustgone]('), embed.fields[0].value);
});

test('trusting a user shows its class from the roster just read', async (t) => {
  const embed = await runTrust(t, { action: 'add', name: 'Trustnew', reason: 'Helper' }, () => new Response(
    '<a href="/character/NA/Trustnew"><div class="text-lg font-semibold">Trustnew<span>1750</span><span>100</span></div></a>'
    + 'roster:[{id:1,name:"Trustnew",class:"berserker",ilvl:1750,combatPower:null,combatPowerIsEstimate:false}]',
  ));

  assert.ok(embed.fields[0].value.startsWith('Berserker [Trustnew]('), embed.fields[0].value);
});
