import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import { createTrustHandlers, persistTrustedRoster } from '../bot/handlers/list/trust/index.js';
import UserPreference from '../bot/models/UserPreference.js';

test('/la-list trust rejects non-officers with an ephemeral alert', async (t) => {
  t.mock.method(UserPreference, 'findOne', () => ({ lean: async () => null }));
  const calls = [];
  const interaction = {
    user: { id: 'not-an-officer', tag: 'NotOfficer#0001' },
    options: {
      getString: () => {
        throw new Error('options should not be read before auth passes');
      },
    },
    reply: async (payload) => calls.push(payload),
  };

  const { handleListTrustCommand } = createTrustHandlers();
  await handleListTrustCommand(interaction);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].flags, MessageFlags.Ephemeral);
  assert.equal(calls[0].embeds.length, 1);
});

// List cards read item level and combat score from the roster snapshots, so a
// trust addition stores the roster it just fetched instead of dropping it.
const SHAWLION = [{ name: 'Shawlion', itemLevel: 1755, combatScore: '4100', classId: 'holy_knight' }];
const trustArgs = (existing) => ({
  existing, name: 'Shawlion', reason: 'friend', allCharacters: ['Shawlion'],
  rosterResult: { hasValidRoster: true, rosterVisibility: 'visible', rosterCharacters: SHAWLION },
  rosterKept: false, interaction: { user: { id: 'officer', tag: 'Officer#0001' } },
});

test('a trust addition or refresh saves the fetched roster as snapshots', async () => {
  for (const existing of [null, { _id: 't1', name: 'Shawlion' }]) {
    const writes = [];
    const saved = [];
    await persistTrustedRoster(trustArgs(existing), {
      TrustedUserModel: { create: async () => writes.push('create'), updateOne: async () => writes.push('update') },
      upsertRosterSnapshotsFn: async (characters, rosterName) => saved.push({ characters, rosterName }),
    });
    assert.deepEqual(writes, [existing ? 'update' : 'create']);
    assert.deepEqual(saved, [{ characters: SHAWLION, rosterName: 'Shawlion' }]);
  }
});

test('a failed snapshot save leaves the trusted entry saved', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const writes = [];
  await persistTrustedRoster(trustArgs(null), {
    TrustedUserModel: { create: async () => writes.push('create') },
    upsertRosterSnapshotsFn: async () => { throw new Error('database down'); },
  });
  assert.deepEqual(writes, ['create']);
});
