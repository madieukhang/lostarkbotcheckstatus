import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import config from '../bot/config.js';
import Blacklist from '../bot/models/Blacklist.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import { createListAddExecutor } from '../bot/handlers/list/services/addExecutor.js';
import { bibleClient } from '../bot/services/roster/bibleClient.js';
import { disconnectDB } from '../bot/db.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';

// The real add executor on a disposable database: the duplicate card names
// who added the entry only when an officer or senior runs the add.
test('the duplicate card names the reporter for an officer and hides it from a member', async (t) => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri('duplicate_reporter'));
  t.after(async () => { await disconnectDB(); await mongo.stop(); });
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external I/O'); });
  t.mock.method(bibleClient, 'fetch', async () => new Response(
    '<a href="/character/NA/Audittarget"><div class="text-lg font-semibold">Audittarget<span>1750</span><span>100</span></div></a>'
  ));
  await Promise.all([Blacklist.init(), TrustedUser.init()]);
  clearUserLanguageCache();
  await Blacklist.create({
    name: 'Audittarget', reason: 'Approved global report', raid: 'Kazeros Hard',
    scope: 'global', guildId: '', addedByUserId: 'reporter', addedByDisplayName: 'Secretreporter',
    allCharacters: ['Audittarget'],
  });
  config.officerApproverIds.push('officer-1');
  t.after(() => config.officerApproverIds.splice(config.officerApproverIds.indexOf('officer-1'), 1));

  const executor = createListAddExecutor({ client: {}, broadcastListChange: async () => assert.fail('a duplicate writes nothing') });
  const cardFor = async (requestedByUserId) => JSON.stringify((await executor({
    requestId: `dupe-${requestedByUserId}`, action: 'add', name: 'Audittarget', type: 'black', scope: 'global',
    reason: 'Again', raid: 'Kazeros Hard', guildId: 'guild-1', requestedByUserId, requestedByDisplayName: 'Asker', lang: 'en',
  })).embeds[0].toJSON());

  assert.equal((await cardFor('member-1')).includes('Secretreporter'), false);
  assert.ok((await cardFor('officer-1')).includes('Secretreporter'));
});
