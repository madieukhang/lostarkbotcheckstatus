import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildUnusableRosterResult } = await import('../bot/handlers/list/services/addExecutor.js');

const noSuggestionLookup = () => assert.fail('a Bible failure must not look up name suggestions');

test('list add reports Bible as unavailable when the roster request failed', async () => {
  const result = await buildUnusableRosterResult(
    'Rateduk',
    { hasValidRoster: false, allCharacters: ['Rateduk'], failReason: 'HTTP 403' },
    'en',
    { fetchSuggestions: noSuggestionLookup }
  );

  assert.equal(result.ok, false);
  assert.match(result.content, /lostark\.bible did not answer/);
  assert.match(result.embeds[0].toJSON().title, /Bible is unavailable/);
});

test('list add keeps the missing-roster card when Bible answered with no roster', async () => {
  const result = await buildUnusableRosterResult(
    'Rateduk',
    { hasValidRoster: false, allCharacters: ['Rateduk'], failReason: null },
    'en',
    { fetchSuggestions: async () => [] }
  );

  assert.equal(result.ok, false);
  assert.doesNotMatch(result.embeds[0].toJSON().title, /Bible is unavailable/);
});

test('list add continues when the roster is usable', async () => {
  const result = await buildUnusableRosterResult(
    'Rateduk',
    { hasValidRoster: true, allCharacters: ['Rateduk'], failReason: null },
    'en',
    { fetchSuggestions: noSuggestionLookup }
  );

  assert.equal(result, null);
});
