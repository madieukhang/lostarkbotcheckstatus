import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildBroadcastFields } = await import('../bot/handlers/list/services/broadcasts.js');
const { createBulkServices } = await import('../bot/handlers/list/services/bulk.js');

test('broadcast fields keep optional metadata ordered without empty placeholders', () => {
  const rosterField = { name: 'Tracked rosters', value: 'Main\nAlt', inline: false };
  const fields = buildBroadcastFields({
    entry: {
      name: 'Main',
      reason: 'New reason',
      raid: 'Aegir',
      addedAt: new Date('2026-08-30T00:00:00Z'),
    },
    action: 'edited',
    snap: { itemLevel: 1790, combatScore: '6180.57' },
    altsField: rosterField,
    lang: 'en',
    previous: { raid: 'Brelshaza' },
    previousReason: 'Old reason',
  });

  // Reason, four inline metadata fields padded to a whole three-column
  // row, then the roster list. The replaced values sit struck above the
  // new ones, as on the /la-list edit card.
  assert.equal(fields.length, 8);
  assert.deepEqual(
    { name: fields[0].name, value: fields[0].value },
    { name: '📝 Reason ✏️', value: '~~Old reason~~\nNew reason' },
  );
  assert.deepEqual(
    { name: fields[1].name, value: fields[1].value },
    { name: '🗡️ Raid ✏️', value: '~~Brelshaza~~\n`Aegir`' },
  );
  // An edit is stamped with the time of the edit, not of the add.
  const [, editedAt] = fields[2].value.match(/^<t:(\d+):R>$/);
  assert.ok(Math.abs(Number(editedAt) - Date.now() / 1000) < 60);
  assert.equal(fields[3].value, '`1790.00`');
  assert.equal(fields[4].value, '`6180.57 CP`');
  assert.equal(fields.filter((field) => field.inline).length % 3, 0);
  assert.equal(fields[7], rosterField);

  const minimal = buildBroadcastFields({
    entry: { name: 'Main', reason: '' },
    action: 'added',
    lang: 'en',
  });
  assert.equal(minimal.length, 1);
  assert.equal(minimal[0].inline, false);
});

test('bulk summary renders each populated outcome once and skips empty buckets', () => {
  const { buildBulkSummaryEmbed } = createBulkServices({
    client: {},
    executeListAddToDatabase: async () => ({ ok: true }),
  });
  const embed = buildBulkSummaryEmbed({
    added: [{ name: 'Added', type: 'black' }],
    skipped: [{ name: 'Skipped', reason: 'duplicate' }],
    failed: [{ name: 'Failed', error: 'write failed' }],
    rehostWarnings: [{ name: 'Image', error: 'upload failed' }],
  }, { requesterDisplayName: 'Tester' }, 'en').toJSON();

  assert.equal(embed.fields.length, 4);
  assert.match(embed.fields[0].value, /Added/);
  assert.match(embed.fields[1].value, /duplicate/);
  assert.match(embed.fields[2].value, /write failed/);
  assert.match(embed.fields[3].value, /upload failed/);

  const empty = buildBulkSummaryEmbed({
    added: [],
    skipped: [],
    failed: [],
    rehostWarnings: [],
  }, { requesterDisplayName: 'Tester' }, 'en').toJSON();
  assert.deepEqual(empty.fields || [], []);
});
