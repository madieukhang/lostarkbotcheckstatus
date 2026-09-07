import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCurrentScraperApiUsageScopeSnapshot,
  getScraperApiUsageSnapshot,
  recordScraperApiRequest,
  resetScraperApiUsageForTests,
  runWithScraperApiUsageScope,
} from '../bot/utils/scraperApiUsage.js';

test('scraper api usage tracks success, http failures, network errors, and per-key counts', () => {
  resetScraperApiUsageForTests();

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

test('usage snapshots and nested scopes retain independent counters', () => {
  resetScraperApiUsageForTests();
  const empty = getCurrentScraperApiUsageScopeSnapshot();
  empty.totalRequests = 99;
  assert.equal(getCurrentScraperApiUsageScopeSnapshot().totalRequests, 0);

  runWithScraperApiUsageScope(() => {
    recordScraperApiRequest({ keyIndex: 0, status: 200, ok: true });
    const before = getCurrentScraperApiUsageScopeSnapshot();
    before.totalRequests = 99;
    runWithScraperApiUsageScope(() => {
      assert.equal(getCurrentScraperApiUsageScopeSnapshot().totalRequests, 0);
      recordScraperApiRequest({ keyIndex: 0, status: 429 });
      assert.equal(getCurrentScraperApiUsageScopeSnapshot().failedResponses, 1);
    });
    assert.equal(getCurrentScraperApiUsageScopeSnapshot().totalRequests, 1);
    assert.equal(getCurrentScraperApiUsageScopeSnapshot().failedResponses, 0);
  });

  const snapshot = getScraperApiUsageSnapshot();
  snapshot.totalRequests = 99;
  assert.equal(getScraperApiUsageSnapshot().totalRequests, 2);
  resetScraperApiUsageForTests();
  assert.equal(getScraperApiUsageSnapshot().totalRequests, 0);
  assert.deepEqual(getScraperApiUsageSnapshot().keyCounts, []);
});
