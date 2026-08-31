import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanupChannelMessages } from '../bot/services/setup/channelCleanup.js';

function fetchedPage(messages, { size = messages.length, lastId } = {}) {
  return {
    size,
    values: () => messages.values(),
    last: () => lastId ? { id: lastId } : undefined,
  };
}

test('channel cleanup preserves pinned and protected messages on a complete page', async () => {
  const deleted = [];
  const messages = [
    { id: 'delete-me', pinned: false, delete: async () => deleted.push('delete-me') },
    { id: 'pinned', pinned: true, delete: async () => deleted.push('pinned') },
    { id: 'protected', pinned: false, delete: async () => deleted.push('protected') },
  ];
  const channel = {
    messages: {
      fetch: async () => fetchedPage(messages),
    },
  };

  const result = await cleanupChannelMessages(channel, {
    protectedMessageIds: ['protected'],
    maxPages: 5,
  });

  assert.deepEqual(deleted, ['delete-me']);
  assert.deepEqual(result, {
    deleted: 1,
    failed: 0,
    scanned: 3,
    truncated: false,
    failureReasons: {},
  });
});

test('channel cleanup marks a full page without a continuation cursor as truncated', async () => {
  let fetchCount = 0;
  const channel = {
    messages: {
      fetch: async () => {
        fetchCount += 1;
        return fetchedPage([], { size: 100 });
      },
    },
  };

  const result = await cleanupChannelMessages(channel, { maxPages: 5 });

  assert.equal(fetchCount, 1);
  assert.equal(result.scanned, 100);
  assert.equal(result.truncated, true);
});

test('channel cleanup marks the final full page as truncated when the page cap is reached', async () => {
  const channel = {
    messages: {
      fetch: async () => fetchedPage([], { size: 100, lastId: 'cursor-1' }),
    },
  };

  const result = await cleanupChannelMessages(channel, { maxPages: 1 });

  assert.equal(result.scanned, 100);
  assert.equal(result.truncated, true);
});
