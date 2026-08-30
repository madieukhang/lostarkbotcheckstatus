import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildInPlaceUpdatePlan,
  buildMovedEntryData,
  buildMovePreflightQuery,
  resolveMoveImageFields,
} = await import('../bot/handlers/list/edit/applyNow.js');
const {
  buildApprovalMoveData,
  buildApprovalUpdateFields,
  resolveApprovalMoveImageFields,
} = await import('../bot/handlers/list/add/editApproval.js');
const {
  buildListEntryCreateData,
} = await import('../bot/handlers/list/services/addExecutor.js');
const {
  buildEnrichCumulativeState,
  buildInitialEnrichProgress,
  resolveEnrichCompletionOutcome,
} = await import('../bot/handlers/list/enrich/index.js');

function makeEntry(overrides = {}) {
  return {
    _id: 'entry-1',
    name: 'Mainchar',
    reason: 'Old reason',
    raid: 'Old raid',
    logsUrl: 'https://old.example/logs',
    imageUrl: '',
    imageMessageId: 'old-message',
    imageChannelId: 'old-channel',
    allCharacters: ['Knownalt'],
    enrichmentSource: 'bible',
    enrichedAt: new Date('2026-08-01T00:00:00Z'),
    scope: 'global',
    ...overrides,
  };
}

test('immediate list move keeps blacklist scope boundaries and permanent image references', () => {
  const existing = makeEntry();
  assert.deepEqual(buildMovePreflightQuery(existing, 'white', 'guild-1'), {
    $or: [{ name: 'Mainchar' }, { allCharacters: 'Mainchar' }],
  });
  assert.deepEqual(resolveMoveImageFields(existing, '', null), {
    imageUrl: '',
    imageMessageId: 'old-message',
    imageChannelId: 'old-channel',
  });

  const moved = buildMovedEntryData({
    existing,
    targetType: 'black',
    editGuildId: 'guild-1',
    editGuildDefaultScope: 'global',
    newReason: 'New reason',
    newRaid: '',
    newLogs: '',
    newImageUrl: 'https://cdn.example/new.png',
    newImageRehost: { messageId: 'new-message', channelId: 'new-channel' },
    newScope: 'server',
    additionalNamesParsed: { added: ['Manualalt'] },
  });

  assert.equal(moved.scope, 'server');
  assert.equal(moved.guildId, 'guild-1');
  assert.equal(moved.imageUrl, '');
  assert.equal(moved.imageMessageId, 'new-message');
  assert.deepEqual(moved.allCharacters, ['Knownalt', 'Manualalt']);
  assert.equal(moved.enrichmentSource, 'manual');
  assert.ok(moved.enrichedAt instanceof Date);
});

test('immediate in-place plan keeps image and scope fields atomic while appending alts', () => {
  const { updateFields, updateOps } = buildInPlaceUpdatePlan({
    newReason: 'New reason',
    newRaid: '',
    newLogs: '',
    newImageUrl: 'https://cdn.example/new.png',
    newImageRehost: null,
    isScopeChange: true,
    targetScope: 'server',
    editGuildId: 'guild-1',
    additionalNamesParsed: { added: ['Manualalt'] },
  });

  assert.equal(updateFields.imageUrl, 'https://cdn.example/new.png');
  assert.equal(updateFields.imageMessageId, '');
  assert.equal(updateFields.imageChannelId, '');
  assert.equal(updateFields.scope, 'server');
  assert.equal(updateFields.guildId, 'guild-1');
  assert.equal(updateFields.enrichmentSource, 'manual');
  assert.deepEqual(updateOps.$addToSet, {
    allCharacters: { $each: ['Manualalt'] },
  });
});

test('approved edits preserve rehost precedence and only persist changed fields', () => {
  const existing = makeEntry();
  const payload = {
    type: 'black',
    scope: 'server',
    guildId: 'guild-1',
    reason: 'New reason',
    raid: 'Old raid',
    imageUrl: 'https://legacy.example/new.png',
    imageMessageId: 'new-message',
    imageChannelId: 'new-channel',
  };

  assert.deepEqual(resolveApprovalMoveImageFields(payload, existing), {
    imageUrl: '',
    imageMessageId: 'new-message',
    imageChannelId: 'new-channel',
  });
  const moved = buildApprovalMoveData(payload, existing);
  assert.equal(moved.scope, 'server');
  assert.equal(moved.guildId, 'guild-1');
  assert.equal(moved.enrichmentSource, 'bible');

  assert.deepEqual(buildApprovalUpdateFields(payload, existing), {
    reason: 'New reason',
    imageUrl: '',
    imageMessageId: 'new-message',
    imageChannelId: 'new-channel',
    scope: 'server',
    guildId: 'guild-1',
  });
});

test('list-add create plan stamps bible enrichment and server scope together', () => {
  const created = buildListEntryCreateData({
    payload: {
      type: 'black',
      reason: 'Reason',
      raid: 'Raid',
      imageMessageId: 'message-1',
      imageChannelId: 'channel-1',
      requestedByUserId: 'user-1',
    },
    name: 'Mainchar',
    allCharacters: ['Knownalt'],
    entryScope: { scope: 'server', guildId: 'guild-1' },
  });

  assert.equal(created.scope, 'server');
  assert.equal(created.guildId, 'guild-1');
  assert.equal(created.imageUrl, '');
  assert.equal(created.enrichmentSource, 'bible');
  assert.ok(created.enrichedAt instanceof Date);
});

test('enrich continuation merges cumulative stats and exposes only unknown alts', () => {
  const cumulative = buildEnrichCumulativeState({
    existingSession: {
      allDiscoveredAlts: [{ name: 'Knownalt', itemLevel: 1710 }],
      scannedNames: ['Memberone'],
      scanStats: { scanned: 2, attempted: 3, failed: 1, rateLimitRetries: 4 },
    },
    result: {
      alts: [
        { name: 'KNOWNALT', itemLevel: 1720 },
        { name: 'Newalt', classId: 204, itemLevel: 1730 },
      ],
      scannedNames: ['Membertwo'],
      scannedCandidates: 5,
      attemptedCandidates: 6,
      failedCandidates: 2,
      rateLimitRetries: 3,
    },
    existingCharacters: ['Knownalt'],
    meta: { guildName: 'Guild' },
  });

  assert.deepEqual(cumulative.scannedNames, ['Memberone', 'Membertwo']);
  assert.equal(cumulative.scanned, 7);
  assert.equal(cumulative.attempted, 9);
  assert.equal(cumulative.failed, 3);
  assert.equal(cumulative.rateLimitRetries, 7);
  assert.deepEqual(cumulative.newAlts.map((alt) => alt.name), ['Newalt']);
  assert.equal(cumulative.sessionProgress.scanStats.totalAlts, 2);
});

test('enrich progress excludes target, low-level, and already-scanned candidates', () => {
  const progress = buildInitialEnrichProgress({
    guildMembers: [
      { name: 'Mainchar', ilvl: 1800 },
      { name: 'Oldcandidate', ilvl: 1800 },
      { name: 'Lowcandidate', ilvl: 1699 },
      { name: 'Freshone', ilvl: 1700 },
      { name: 'Freshtwo', ilvl: 1710 },
    ],
    name: 'Mainchar',
    existingSession: { scannedNames: ['oldcandidate'] },
    resolvedCap: 1,
    startedAt: 123,
  });

  assert.equal(progress.totalCandidates, 1);
  assert.equal(progress.totalMembers, 5);
  assert.equal(progress.startedAt, 123);
});

test('enrich completion outcome keeps stopped and completed branches distinct', () => {
  assert.equal(resolveEnrichCompletionOutcome({ stopReason: 'stopped' }, 0), 'stopped-no-alts');
  assert.equal(resolveEnrichCompletionOutcome({ stopReason: 'failure-storm' }, 2), 'stopped-with-alts');
  assert.equal(resolveEnrichCompletionOutcome({ stopReason: null }, 0), 'no-alts');
  assert.equal(resolveEnrichCompletionOutcome({ stopReason: null }, 2), 'completed');
});
