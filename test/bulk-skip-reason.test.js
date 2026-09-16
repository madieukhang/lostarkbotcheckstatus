import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { disconnectDB } = await import('../bot/db.js');
const { createBulkServices } = await import('../bot/handlers/list/services/bulk.js');

for (const { content, reason } of [
  { content: '⚠️ **Mokoko** is blocked\nsecond line', reason: 'Mokoko is blocked' },
  { content: '**Mokoko** is 🔒 locked', reason: 'Mokoko is 🔒 locked' },
]) {
  test(`bulk skip reason for ${JSON.stringify(content)} is ${JSON.stringify(reason)}`, async (t) => {
    t.mock.method(mongoose, 'connect', async () => mongoose);
    t.after(disconnectDB);
    const { executeBulkMultiadd } = createBulkServices({
      client: {},
      executeListAddToDatabase: async () => ({ ok: false, content }),
    });

    const results = await executeBulkMultiadd(
      [{ name: 'Mokoko', type: 'watch', reason: 'Left mid-raid' }],
      { requesterId: 'requester-1' },
    );

    assert.deepEqual(results.skipped, [{ name: 'Mokoko', reason }]);
  });
}
