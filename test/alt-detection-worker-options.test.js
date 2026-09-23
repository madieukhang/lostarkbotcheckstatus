import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

const { bibleClient } = await import('../bot/services/roster/bibleClient.js');
const { detectAltsViaStronghold } = await import('../bot/services/roster/altDetection.js');

test('a worker-routed scan also routes the hidden-roster item level lookup', async (t) => {
  const calls = [];
  t.mock.method(bibleClient, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({}) };
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});

  // No itemLevel on the target meta: the detector falls back to the search
  // endpoint, which is the request this test follows.
  const result = await detectAltsViaStronghold('Hiddenmain', {
    viaWorker: true,
    targetMeta: { guildName: 'Guild', strongholdName: 'Keep', strongholdLevel: 70, rosterLevel: 250 },
    guildMembers: [],
  });

  assert.equal(result, null);
  const search = calls.find(({ url }) => url.includes('/search?'));
  assert.ok(search, 'the hidden-roster lookup asks the search endpoint');
  assert.equal(search.options.viaWorker, true);
});
