import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

let backfillTrustedRosterLinks;

test.before(async () => {
  ({ backfillTrustedRosterLinks } = await import('../bot/services/maintenance/trustedBackfill.js'));
});

function createTrustedUserModel(entries) {
  const updates = [];
  return {
    updates,
    find(query) {
      assert.deepEqual(query, {
        $or: [
          { allCharacters: { $exists: false } },
          { allCharacters: { $size: 0 } },
        ],
      });
      return {
        sort(sortSpec) {
          assert.deepEqual(sortSpec, { addedAt: 1 });
          return {
            limit(limit) {
              assert.equal(limit, 25);
              return {
                async lean() {
                  return entries;
                },
              };
            },
          };
        },
      };
    },
    async updateOne(filter, update) {
      updates.push({ filter, update });
    },
  };
}

test('trusted roster backfill stores roster alts for legacy trusted entries', async () => {
  const model = createTrustedUserModel([
    { _id: 'trusted-1', name: 'Clauseduk', addedAt: new Date('2026-04-08T10:40:15Z') },
  ]);

  const stats = await backfillTrustedRosterLinks({
    TrustedUserModel: model,
    buildRosterCharactersFn: async (name, options) => {
      assert.equal(name, 'Clauseduk');
      assert.equal(options.hiddenRosterFallback, true);
      return {
        hasValidRoster: true,
        allCharacters: ['Clauseduk', 'Morrahduk', 'Episduk', 'Morrahduk'],
      };
    },
  });

  assert.deepEqual(stats, { scanned: 1, updated: 1, failed: 0 });
  assert.equal(model.updates.length, 1);
  assert.deepEqual(model.updates[0].filter, {
    _id: 'trusted-1',
    $or: [
      { allCharacters: { $exists: false } },
      { allCharacters: { $size: 0 } },
    ],
  });
  assert.deepEqual(model.updates[0].update.$set.allCharacters, ['Clauseduk', 'Morrahduk', 'Episduk']);
  assert.equal(model.updates[0].update.$set.enrichmentSource, 'bible');
  assert.ok(model.updates[0].update.$set.enrichedAt instanceof Date);
});

test('trusted roster backfill marks missing rosters as manual primary-only links', async () => {
  const model = createTrustedUserModel([
    { _id: 'trusted-2', name: 'Hiddenmain', addedAt: new Date('2026-04-08T11:00:00Z') },
  ]);

  const stats = await backfillTrustedRosterLinks({
    TrustedUserModel: model,
    buildRosterCharactersFn: async () => ({
      hasValidRoster: false,
      allCharacters: [],
    }),
  });

  assert.deepEqual(stats, { scanned: 1, updated: 1, failed: 0 });
  assert.deepEqual(model.updates[0].update.$set.allCharacters, ['Hiddenmain']);
  assert.equal(model.updates[0].update.$set.enrichmentSource, 'manual');
});
