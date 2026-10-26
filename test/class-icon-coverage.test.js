import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PendingApproval from '../bot/models/PendingApproval.js';
import RosterSnapshot from '../bot/models/RosterSnapshot.js';
import TrustedUser from '../bot/models/TrustedUser.js';
import UserPreference from '../bot/models/UserPreference.js';
import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { createAddHandlers } from '../bot/handlers/list/add/index.js';
import { handleApprovedEditRequest } from '../bot/handlers/list/add/editApproval.js';
import { createListAddOverwriteButtonHandler } from '../bot/handlers/list/add/overwriteButton.js';
import { buildDuplicateApprovalEmbed } from '../bot/handlers/list/duplicate-ui.js';
import { buildTrustedBlockEmbed } from '../bot/handlers/list/helpers.js';
import { buildItemLevelRejection, createListAddExecutor } from '../bot/handlers/list/services/addExecutor.js';
import { formatSuggestionLines } from '../bot/services/roster/search.js';
import { normalizeNameKey } from '../bot/utils/names.js';
import { clearUserLanguageCache } from '../bot/services/i18n/index.js';
import { disconnectDB } from '../bot/db.js';
import { mockPendingApprovalModel } from './helpers/pending-approval-model.js';

// Class emoji are bootstrapped from the application at runtime, so in tests
// the class name stands in for the icon.
const REQUEST = {
  requestId: 'dupe', action: 'add', name: 'Newmain', type: 'black', scope: 'global',
  reason: 'New report', raid: '', guildId: 'origin-guild', approverIds: ['approver'],
  requestedByUserId: 'requester', requestedByDisplayName: 'Requester',
};
const EXISTING = {
  _id: 'original', name: 'Original', reason: 'Old report', scope: 'global',
  addedByDisplayName: 'Officer', addedAt: new Date('2026-10-01T00:00:00Z'),
};
const SNAPSHOTS = [
  { name: 'Newmain', classId: 'berserker' },
  { name: 'Original', classId: 'berserker_female' },
];

function stubEnglishViewer(t) {
  t.mock.method(mongoose, 'connect', async () => mongoose);
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => ({ language: 'en' }) }));
  clearUserLanguageCache();
  t.after(async () => { clearUserLanguageCache(); await disconnectDB(); });
}

function assertDuplicateCardClasses(embed) {
  assert.ok(embed.description.includes('Berserker **[Newmain]('), embed.description);
  assert.ok(embed.description.includes('Slayer **[Original]('), embed.description);
  const comparison = embed.fields.slice(-2).map((field) => field.value);
  assert.ok(comparison[0].startsWith('Slayer **[Original]('), comparison[0]);
  assert.ok(comparison[1].startsWith('Berserker **[Newmain]('), comparison[1]);
}

test('the approver duplicate card shows the class of both characters', () => {
  const statMap = new Map(SNAPSHOTS.map((snapshot) => [normalizeNameKey(snapshot.name), snapshot]));

  assertDuplicateCardClasses(buildDuplicateApprovalEmbed(EXISTING, REQUEST, 'en', statMap).toJSON());
});

test('approving into a duplicate reads both snapshots for the duplicate card', async (t) => {
  stubEnglishViewer(t);
  mockPendingApprovalModel(t, PendingApproval, REQUEST);
  const lookups = [];
  const handlers = createAddHandlers({
    client: {},
    services: {
      executeListAddToDatabase: async () => ({ ok: false, isDuplicate: true, existingEntry: EXISTING }),
      syncApproverDmMessages: async () => {},
      notifyRequesterAboutDecision: async () => {},
      broadcastListChange: async () => {},
      findRosterSnapshot: async (name) => {
        lookups.push(name);
        return SNAPSHOTS.find((snapshot) => snapshot.name === name) || null;
      },
    },
  });
  const edits = [];
  await handlers.handleListAddApprovalButton({
    customId: 'listadd_approve:dupe', user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
    client: { guilds: { cache: new Map() } },
    deferUpdate: async () => {}, editReply: async (payload) => { edits.push(payload); },
    reply: async () => {}, followUp: async () => {},
  });

  assert.deepEqual(lookups.sort(), ['Newmain', 'Original']);
  assertDuplicateCardClasses(edits.at(-1).embeds[0].toJSON());
});

test('the Trusted block card shows the class of the blocked character', () => {
  const embed = buildTrustedBlockEmbed('Newmain', 'Trusted officer', {
    record: { name: 'Newmain', classId: 'berserker' },
  }).toJSON();

  assert.ok(embed.fields[0].value.startsWith('Berserker [Newmain]('), embed.fields[0].value);
});

test('Add to history blocked by Trusted shows the class from the refreshed roster', async (t) => {
  stubEnglishViewer(t);
  mockPendingApprovalModel(t, PendingApproval, { ...REQUEST, duplicateEntryId: 'original' });
  const { default: Blacklist } = await import('../bot/models/Blacklist.js');
  t.mock.method(Blacklist, 'findById', () => Object.assign(Promise.resolve(EXISTING), { lean: async () => EXISTING }));
  t.mock.method(TrustedUser, 'findOne', () => ({ collation() { return this; }, lean: async () => ({ name: 'Newmain', reason: 'Trusted officer' }) }));
  const edits = [];

  await createListAddOverwriteButtonHandler({
    buildRosterCharactersFn: async () => ({
      hasValidRoster: true,
      allCharacters: ['Newmain'],
      rosterCharacters: [{ name: 'Newmain', classId: 'berserker', className: 'Berserker' }],
    }),
    syncApproverDmMessages: async () => {},
    broadcastListChange: async () => assert.fail('a Trusted block writes nothing'),
    notifyRequesterAboutDecision: async () => {},
  })({
    customId: 'listadd_overwrite:dupe', user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
    client: { guilds: { cache: new Map() } },
    deferUpdate: async () => {}, editReply: async (value) => { edits.push(value); },
  });

  const field = edits.at(-1).embeds[0].toJSON().fields[0];
  assert.ok(field.value.startsWith('Berserker [Newmain]('), field.value);
});

test('adding a Trusted name shows its class from the roster snapshot on the block card', async (t) => {
  stubEnglishViewer(t);
  t.mock.method(TrustedUser, 'findOne', () => ({ collation() { return this; }, lean: async () => ({ name: 'Newmain', reason: 'Trusted officer' }) }));
  t.mock.method(RosterSnapshot, 'findOne', () => ({ collation() { return this; }, lean: async () => ({ name: 'Newmain', classId: 'berserker' }) }));
  const executeListAddToDatabase = createListAddExecutor({ client: {}, broadcastListChange: async () => {} });

  const result = await executeListAddToDatabase({ ...REQUEST, lang: 'en' });

  assert.equal(result.ok, false);
  const field = result.embeds[0].toJSON().fields[0];
  assert.ok(field.value.startsWith('Berserker [Newmain]('), field.value);
});

test('an approved edit blocked by Trusted shows the class on the block card', async (t) => {
  const { default: Blacklist } = await import('../bot/models/Blacklist.js');
  const entry = { _id: 'a'.repeat(24), name: 'Newmain', reason: 'Old', scope: 'server', guildId: 'origin-guild', allCharacters: [] };
  t.mock.method(Blacklist, 'findById', async () => entry);
  t.mock.method(TrustedUser, 'findOne', () => ({ collation() { return this; }, lean: async () => ({ name: 'Newmain', reason: 'Trusted officer' }) }));
  const replies = [];

  await handleApprovedEditRequest({
    payload: { ...REQUEST, action: 'edit', existingEntryId: entry._id, currentType: 'black', scope: 'global' },
    lang: 'en',
    interaction: {
      deferred: true, user: { id: 'approver', tag: 'aurel' }, message: { id: 'dm' },
      client: { guilds: { cache: new Map() } }, editReply: async (reply) => { replies.push(reply); },
    },
    completeApproval: async () => {},
    beforeWrite: async () => assert.fail('a Trusted block writes nothing'),
    syncApproverDmMessages: async () => {},
    broadcastListChange: async () => {},
    notifyRequesterAboutDecision: async () => {},
    findRosterSnapshot: async (name) => SNAPSHOTS.find((snapshot) => snapshot.name === name) || null,
  });

  const field = replies.at(-1).embeds[0].toJSON().fields[0];
  assert.ok(field.value.startsWith('Berserker [Newmain]('), field.value);
});

test('the item level rejection shows the class of the rejected character', () => {
  const result = buildItemLevelRejection({
    name: 'Lowalt', targetItemLevel: 1500, labelCap: 'Blacklist', lang: 'en',
    record: { name: 'Lowalt', classId: 'berserker', className: 'Berserker' },
  });

  const field = result.embeds[0].toJSON().fields[0];
  assert.ok(field.value.startsWith('Berserker [Lowalt]('), field.value);
});

test('hidden-roster name suggestions show the class icon like the /la-list add suggestions', (t) => {
  const previous = CLASS_EMOJI_MAP.Berserker;
  CLASS_EMOJI_MAP.Berserker = '<:berserker:1>';
  t.after(() => { CLASS_EMOJI_MAP.Berserker = previous; });

  const line = formatSuggestionLines([{ name: 'Lowalt', itemLevel: 1700, cls: 'berserker' }]);

  assert.ok(line.endsWith('· <:berserker:1>'), line);
});
