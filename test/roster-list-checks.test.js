import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { shapeRosterListHit } = await import('../bot/services/roster/listChecks.js');

test('/la-roster list-hit evidence payload keeps roster metadata', () => {
  const addedAt = new Date('2026-05-17T00:00:00Z');
  const shaped = shapeRosterListHit({
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

  assert.deepEqual(shaped.allCharacters, ['Main', 'Altone']);
  assert.equal(shaped.logsUrl, 'https://logs.example/Main');
  assert.equal(shaped.addedAt, addedAt);
  assert.equal(shaped.scope, 'server');
  assert.equal(shaped.guildId, 'guild-1');
});
