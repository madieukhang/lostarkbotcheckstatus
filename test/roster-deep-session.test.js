import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRosterContinuationSessionPayload,
  clearRosterDeepSession,
  createRosterContinuationSession,
  getRosterDeepSession,
} from '../bot/utils/rosterDeepSession.js';

test('hidden and visible roster continuations project the same cumulative scan context', () => {
  const shared = {
    callerId: 'caller-1',
    targetName: 'Targetname',
    meta: { guildName: 'Test Guild' },
    guildMembers: [{ name: 'Memberone', ilvl: 1710 }],
    altResult: {
      scannedNames: ['Memberone'],
      alts: [{ name: 'Altone' }],
      scannedCandidates: 12,
      attemptedCandidates: 10,
      failedCandidates: 2,
      rateLimitRetries: 3,
    },
    cap: 25,
    primaryEmbedJSON: { title: 'Roster' },
  };

  const hidden = buildRosterContinuationSessionPayload({ ...shared, isHidden: true });
  const visible = buildRosterContinuationSessionPayload({ ...shared, isHidden: false });

  assert.deepEqual(hidden, { ...visible, isHidden: true });
  assert.deepEqual(hidden.scanStats, {
    scanned: 12,
    attempted: 10,
    failed: 2,
    rateLimitRetries: 3,
  });
  assert.strictEqual(hidden.scannedNames, shared.altResult.scannedNames);
  assert.strictEqual(hidden.allDiscoveredAlts, shared.altResult.alts);
});

test('roster continuation keeps legacy defaults and registers the projected session', () => {
  const options = {
    callerId: 'caller-2',
    targetName: 'Targettwo',
    isHidden: false,
    meta: { guildName: 'Test Guild' },
    guildMembers: [],
    altResult: {
      scannedCandidates: 7,
      attemptedCandidates: 0,
    },
    cap: 0,
    primaryEmbedJSON: { title: 'Visible roster' },
  };

  const session = createRosterContinuationSession(options);
  try {
    assert.strictEqual(getRosterDeepSession(session.sessionId), session);
    assert.deepEqual(session.scannedNames, []);
    assert.deepEqual(session.allDiscoveredAlts, []);
    assert.deepEqual(session.scanStats, {
      scanned: 7,
      attempted: 0,
      failed: 0,
      rateLimitRetries: 0,
    });
  } finally {
    clearRosterDeepSession(session.sessionId);
  }
});
