import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildVisibleRosterLines,
  formatItemLevelDelta,
  formatVisibleRosterLine,
} = await import('../bot/handlers/roster/command.js');
const { resolveRosterScanOutcome } = await import('../bot/handlers/roster/completion.js');
const { mergeContinuationScanResult } = await import('../bot/handlers/roster/deepContinue.js');

test('/la-roster renders CP as a code badge with the unit after the score', () => {
  const line = formatVisibleRosterLine({
    name: 'Aresvn',
    itemLevel: '1790',
    combatScore: '≈6180.57',
  }, 0, {
    classPrefix: '<:paladin:42>',
    delta: ' *(+10.00)*',
  });

  assert.equal(
    line,
    '**1.** <:paladin:42> Aresvn · `1790` *(+10.00)* · `≈6180.57 CP`'
  );
});

test('/la-roster item-level delta keeps signed two-decimal formatting', () => {
  assert.equal(formatItemLevelDelta('1,790', 1780), ' *(+10.00)*');
  assert.equal(formatItemLevelDelta('1762.5', 1763.33), ' *(-0.83)*');
  assert.equal(formatItemLevelDelta('1700', 1700), '');
  assert.equal(formatItemLevelDelta('1700', 0), '');
});

test('/la-roster visible rows reuse snapshot deltas without mutating input', () => {
  const characters = [{
    name: 'Aresvn',
    className: 'Paladin',
    itemLevel: '1790',
    combatScore: '≈6180.57',
  }];
  const snapshots = new Map([['aresvn', { itemLevel: 1780 }]]);

  const [line] = buildVisibleRosterLines(characters, snapshots, 'en');

  assert.match(line, /Aresvn/);
  assert.match(line, /\*\(\+10\.00\)\*/);
  assert.equal(characters[0].itemLevel, '1790');
});

test('roster scan completion outcome is shared across terminal entry points', () => {
  assert.equal(resolveRosterScanOutcome(null), null);
  assert.equal(resolveRosterScanOutcome({ alts: [] }), 'no-alts');
  assert.equal(resolveRosterScanOutcome({ alts: [{ name: 'Alt' }] }), 'completed');
  assert.equal(resolveRosterScanOutcome({ cancelled: true, alts: [] }), 'stopped-no-alts');
  assert.equal(
    resolveRosterScanOutcome({ pausedForFailureStorm: true, alts: [{ name: 'Alt' }] }),
    'stopped-with-alts'
  );
  assert.equal(resolveRosterScanOutcome({ alts: [] }, { hasRemaining: true }), null);
});

test('continued roster passes merge alts and accumulate scan counters once', () => {
  const session = {
    allDiscoveredAlts: [{ name: 'Existing', itemLevel: 1700 }],
    scannedNames: ['Existing'],
    scanStats: { scanned: 1, attempted: 2, failed: 1, rateLimitRetries: 1 },
  };
  const cumulative = mergeContinuationScanResult(session, {
    alts: [
      { name: 'existing', itemLevel: 1710 },
      { name: 'NewAlt', itemLevel: 1720 },
    ],
    scannedNames: ['NewAlt'],
    scannedCandidates: 1,
    attemptedCandidates: 2,
    failedCandidates: 1,
    rateLimitRetries: 2,
  });

  assert.deepEqual(cumulative.alts.map((alt) => alt.name), ['existing', 'NewAlt']);
  assert.equal(cumulative.alts[0].itemLevel, 1710);
  assert.deepEqual(cumulative.scannedNames, ['Existing', 'NewAlt']);
  assert.equal(cumulative.scannedCandidates, 2);
  assert.equal(cumulative.attemptedCandidates, 4);
  assert.equal(cumulative.failedCandidates, 2);
  assert.equal(cumulative.rateLimitRetries, 3);
});
