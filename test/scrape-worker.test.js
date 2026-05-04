import test from 'node:test';
import assert from 'node:assert/strict';

import { buildClaimNextJobFilter } from '../bot/services/scrapeWorker.js';

test('scrape worker claims pending jobs and stale in-progress jobs only', () => {
  const nowMs = Date.parse('2026-05-05T00:00:00Z');
  const filter = buildClaimNextJobFilter({
    now: () => nowMs,
    staleAfterMs: 120_000,
  });

  assert.deepEqual(filter, {
    $or: [
      { status: 'pending' },
      {
        status: 'in_progress',
        startedAt: { $lt: new Date(nowMs - 120_000) },
      },
    ],
  });
});
