import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAutoCheckCleanupEligibility,
  resolveAutoCheckCleanupEnabled,
} from '../bot/services/setup/autoCheckCleanupPolicy.js';

test('cleanup policy keeps explicit per-server choices authoritative', () => {
  assert.equal(
    resolveAutoCheckCleanupEnabled(
      { autoCheckCleanupEnabled: false },
      'owner',
      'owner'
    ),
    false
  );
  assert.equal(
    resolveAutoCheckCleanupEnabled(
      { autoCheckCleanupEnabled: true },
      'private',
      'owner'
    ),
    true
  );
});

test('legacy cleanup defaults on only for the global owner guild', () => {
  assert.equal(resolveAutoCheckCleanupEnabled({}, 'owner', 'owner'), true);
  assert.equal(resolveAutoCheckCleanupEnabled({}, 'private', 'owner'), false);
  assert.equal(resolveAutoCheckCleanupEnabled({}, 'private', ''), false);
});

test('cleanup eligibility includes explicit opt-ins plus the legacy owner fallback', () => {
  assert.deepEqual(buildAutoCheckCleanupEligibility('owner'), {
    $or: [
      { autoCheckCleanupEnabled: true },
      {
        guildId: 'owner',
        autoCheckCleanupEnabled: { $exists: false },
      },
    ],
  });
  assert.deepEqual(buildAutoCheckCleanupEligibility(), {
    autoCheckCleanupEnabled: true,
  });
});
