import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildDuplicateAuditFields,
  buildHiddenRosterGuidance,
} = await import('../bot/handlers/list/services/addExecutor.js');

test('hidden roster add guidance offers enrich when bible exposes a guild', () => {
  const guidance = buildHiddenRosterGuidance('Ainslinn', 'Bullet Shell');

  assert.equal(guidance.fields.length, 1);
  assert.match(guidance.fields[0].value, /Bible shows guild \*\*Bullet Shell\*\*/);
  assert.match(guidance.fields[0].value, /\/la-list enrich name:Ainslinn/);
  assert.equal(guidance.components.length, 1);
});

test('hidden roster add guidance avoids enrich button without a guild', () => {
  const guidance = buildHiddenRosterGuidance('Ainslinn', '');

  assert.equal(guidance.fields.length, 1);
  assert.match(guidance.fields[0].value, /needs a visible guild member list/);
  assert.match(guidance.fields[0].value, /\/la-list edit name:Ainslinn additional_names:Alt1, Alt2/);
  assert.equal(guidance.components.length, 0);
});

test('duplicate roster card places Time added beside Added by', () => {
  const addedAt = new Date('2026-05-17T10:30:00Z');
  const fields = buildDuplicateAuditFields({
    addedByDisplayName: 'meow',
    addedAt,
  }, 'en');

  assert.deepEqual(fields, [
    { name: 'Added by', value: 'meow', inline: true },
    {
      name: 'Time added',
      value: `<t:${Math.floor(addedAt.getTime() / 1000)}:R>`,
      inline: true,
    },
  ]);
});

test('duplicate audit fields tolerate missing legacy metadata', () => {
  const fields = buildDuplicateAuditFields({}, 'vi');

  assert.deepEqual(fields, [
    { name: 'Được thêm bởi', value: 'Chưa có', inline: true },
    { name: 'Thời gian thêm', value: 'Chưa có', inline: true },
  ]);
});
