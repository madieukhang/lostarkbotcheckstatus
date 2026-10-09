import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
  shapeRosterListHit,
} = await import('../bot/services/roster/listChecks.js');

function failingQuery() {
  const query = {
    collation: () => query,
    lean: async () => { throw new Error('connection reset'); },
  };
  return query;
}

test('/la-roster blacklist check fails closed when the lookup errors', async () => {
  await assert.rejects(
    handleRosterBlackListCheck(['Main'], {
      guildId: 'guild-1',
      BlacklistModel: { find: failingQuery },
      connectDBFn: async () => {},
    }),
    /connection reset/
  );
});

test('/la-roster whitelist check fails closed when the lookup errors', async () => {
  await assert.rejects(
    handleRosterWhiteListCheck(['Main'], {
      WhitelistModel: { findOne: failingQuery },
      connectDBFn: async () => {},
    }),
    /connection reset/
  );
});

test('/la-roster list-hit evidence payload keeps roster metadata', () => {
  const addedAt = new Date('2026-05-17T00:00:00Z');
  const shaped = shapeRosterListHit({
    _id: 'e'.repeat(24),
    name: 'Main',
    reason: 'test reason',
    raid: 'Thaemine',
    logsUrl: 'https://logs.example/Main',
    imageMessageId: 'message-1',
    imageChannelId: 'channel-1',
    allCharacters: ['Main', 'Altone'],
    addedAt,
    addedByDisplayName: 'Officer',
    scope: 'server',
    guildId: 'guild-1',
  });

  assert.equal(shaped._id, 'e'.repeat(24), 'the /la-roster report button reloads the entry by id');
  assert.deepEqual(shaped.allCharacters, ['Main', 'Altone']);
  assert.equal(shaped.logsUrl, 'https://logs.example/Main');
  assert.equal(shaped.addedAt, addedAt);
  assert.equal(shaped.scope, 'server');
  assert.equal(shaped.guildId, 'guild-1');
});
