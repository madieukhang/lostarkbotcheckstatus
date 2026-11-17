import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

const { resolveEnrichTargetVisibility } = await import('../bot/handlers/list/enrich/index.js');

// List cards read item level and combat score from the roster snapshots, so
// the roster the enrich probe fetched is saved instead of dropped.
test('the enrich probe saves the roster it fetched as snapshots', async () => {
  const roster = [{ name: 'Main', itemLevel: 1755, classId: 'bard' }];
  const saved = [];
  const result = await resolveEnrichTargetVisibility({
    name: 'Main', existingSession: null, lang: 'en', replyEditor: { edit: async () => {} },
    buildRosterCharactersFn: async () => ({ hasValidRoster: true, rosterVisibility: 'visible', rosterCharacters: roster }),
    saveSnapshotsFn: async (characters, rosterName) => saved.push({ characters, rosterName }),
  });
  assert.deepEqual(result, { ok: true, targetIsHidden: false });
  assert.deepEqual(saved, [{ characters: roster, rosterName: 'Main' }]);
});
