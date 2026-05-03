import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffScraperApiUsage,
  getCurrentScraperApiUsageScopeSnapshot,
  getScraperApiUsageSnapshot,
  recordScraperApiRequest,
  resetScraperApiUsageForTests,
  runWithScraperApiUsageScope,
} from '../bot/utils/scraperApiUsage.js';

test('scraper api usage tracks success, http failures, network errors, and per-key counts', () => {
  resetScraperApiUsageForTests();
  const start = getScraperApiUsageSnapshot();

  recordScraperApiRequest({ keyIndex: 0, status: 200, ok: true });
  recordScraperApiRequest({ keyIndex: 1, status: 429, ok: false });
  recordScraperApiRequest({ keyIndex: 1, error: new Error('socket closed') });

  const snapshot = getScraperApiUsageSnapshot();
  assert.equal(snapshot.totalRequests, 3);
  assert.equal(snapshot.successResponses, 1);
  assert.equal(snapshot.failedResponses, 2);
  assert.equal(snapshot.networkErrors, 1);
  assert.equal(snapshot.lastError, 'socket closed');
  assert.deepEqual(snapshot.statusCounts, { 200: 1, 429: 1 });
  assert.deepEqual(
    snapshot.keyCounts.map((key) => ({
      keyNumber: key.keyNumber,
      totalRequests: key.totalRequests,
      successResponses: key.successResponses,
      failedResponses: key.failedResponses,
      networkErrors: key.networkErrors,
    })),
    [
      {
        keyNumber: 1,
        totalRequests: 1,
        successResponses: 1,
        failedResponses: 0,
        networkErrors: 0,
      },
      {
        keyNumber: 2,
        totalRequests: 2,
        successResponses: 0,
        failedResponses: 2,
        networkErrors: 1,
      },
    ],
  );

  const delta = diffScraperApiUsage(start);
  assert.deepEqual(delta, {
    totalRequests: 3,
    successResponses: 1,
    failedResponses: 2,
    networkErrors: 1,
  });
});

test('scoped scraper api usage isolates concurrent async work', async () => {
  resetScraperApiUsageForTests();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const [first, second] = await Promise.all([
    runWithScraperApiUsageScope(async () => {
      await sleep(5);
      recordScraperApiRequest({ keyIndex: 0, status: 200, ok: true });
      await sleep(5);
      return getCurrentScraperApiUsageScopeSnapshot();
    }),
    runWithScraperApiUsageScope(async () => {
      recordScraperApiRequest({ keyIndex: 1, status: 503, ok: false });
      await sleep(1);
      recordScraperApiRequest({ keyIndex: 1, error: new Error('timeout') });
      return getCurrentScraperApiUsageScopeSnapshot();
    }),
  ]);

  assert.equal(first.totalRequests, 1);
  assert.equal(first.successResponses, 1);
  assert.equal(first.failedResponses, 0);

  assert.equal(second.totalRequests, 2);
  assert.equal(second.successResponses, 0);
  assert.equal(second.failedResponses, 2);
  assert.equal(second.networkErrors, 1);

  const processSnapshot = getScraperApiUsageSnapshot();
  assert.equal(processSnapshot.totalRequests, 3);
  assert.equal(processSnapshot.successResponses, 1);
  assert.equal(processSnapshot.failedResponses, 2);
});
