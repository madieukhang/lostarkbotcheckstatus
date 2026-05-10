import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';

const {
  claimAutoCheckMessage,
  completeAutoCheckMessage,
  resetAutoCheckDedupeForTest,
} = await import('../bot/handlers/list/auto-check.js');

test('auto-check rejects duplicate in-flight message events', () => {
  resetAutoCheckDedupeForTest();

  assert.equal(claimAutoCheckMessage('message-1', 1000), true);
  assert.equal(claimAutoCheckMessage('message-1', 1001), false);

  completeAutoCheckMessage('message-1', { processed: true, now: 1002 });
});

test('auto-check remembers processed messages for the dedupe TTL', () => {
  resetAutoCheckDedupeForTest();

  assert.equal(claimAutoCheckMessage('message-2', 2000), true);
  completeAutoCheckMessage('message-2', { processed: true, now: 2001 });

  assert.equal(claimAutoCheckMessage('message-2', 3000), false);
  assert.equal(claimAutoCheckMessage('message-2', 2001 + 11 * 60 * 1000), true);

  completeAutoCheckMessage('message-2', { processed: true, now: 2001 + 11 * 60 * 1000 });
});

test('auto-check releases inactive-channel claims without marking processed', () => {
  resetAutoCheckDedupeForTest();

  assert.equal(claimAutoCheckMessage('message-3', 4000), true);
  completeAutoCheckMessage('message-3', { processed: false, now: 4001 });

  assert.equal(claimAutoCheckMessage('message-3', 4002), true);
  completeAutoCheckMessage('message-3', { processed: true, now: 4003 });
});
