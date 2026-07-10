import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { upsertRosterSnapshots } = await import('../bot/services/roster/rosterSnapshots.js');

test('upsertRosterSnapshots stores one normalized bulk update per roster character', async () => {
  let operations;
  const result = await upsertRosterSnapshots([
    { name: 'Main', classId: 'bard', itemLevel: '1,745.83', combatScore: '4501.2' },
    { name: 'Alt', classId: 'blade', itemLevel: 1710, combatScore: '?' },
    { name: '', classId: 'warlord', itemLevel: 1700 },
  ], 'Main', {
    RosterSnapshotModel: {
      async bulkWrite(received) { operations = received; return { ok: 1 }; },
    },
    now: new Date('2026-07-10T00:00:00.000Z'),
  });

  assert.equal(result.ok, 1);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0], {
    updateOne: {
      filter: { name: 'Main' },
      update: { $set: {
        itemLevel: 1745.83,
        classId: 'bard',
        combatScore: '4501.2',
        rosterName: 'Main',
        updatedAt: new Date('2026-07-10T00:00:00.000Z'),
      } },
      upsert: true,
      collation: { locale: 'en', strength: 2 },
    },
  });
  assert.equal('combatScore' in operations[1].updateOne.update.$set, false);
});

test('upsertRosterSnapshots is a no-op for an empty roster', async () => {
  let called = false;
  const result = await upsertRosterSnapshots([], 'Main', {
    RosterSnapshotModel: { async bulkWrite() { called = true; } },
  });

  assert.equal(result, null);
  assert.equal(called, false);
});
