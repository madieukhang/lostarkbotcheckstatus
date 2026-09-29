import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAutoCheckCleanupEnabled } from '../bot/services/setup/autoCheckCleanupPolicy.js';

test('cleanup policy keeps explicit per-server choices authoritative', () => {
  assert.equal(
    resolveAutoCheckCleanupEnabled({ autoCheckCleanupEnabled: false }),
    false
  );
  assert.equal(
    resolveAutoCheckCleanupEnabled({ autoCheckCleanupEnabled: true }),
    true
  );
});

test('cleanup defaults off for every guild including the global owner', () => {
  assert.equal(resolveAutoCheckCleanupEnabled({}), false);
  assert.equal(resolveAutoCheckCleanupEnabled(null), false);
});
