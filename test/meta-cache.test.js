import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clearMetaCache,
  configureMetaCache,
  getCachedMeta,
  setCachedMeta,
} from '../bot/utils/metaCache.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_SIZE = 5000;

test.afterEach(() => {
  clearMetaCache();
  configureMetaCache({ ttlMs: DEFAULT_TTL_MS, maxSize: DEFAULT_MAX_SIZE });
});

test('refreshing the newest cache key does not evict an unrelated entry', () => {
  configureMetaCache({ ttlMs: DEFAULT_TTL_MS, maxSize: 2 });
  setCachedMeta('Alpha', { value: 1 });
  setCachedMeta('Beta', { value: 2 });

  setCachedMeta('Beta', { value: 3 });

  assert.deepEqual(getCachedMeta('Alpha'), { value: 1 });
  assert.deepEqual(getCachedMeta('Beta'), { value: 3 });
});

test('refreshing a cache key moves it to the MRU edge', () => {
  configureMetaCache({ ttlMs: DEFAULT_TTL_MS, maxSize: 2 });
  setCachedMeta('Alpha', { value: 1 });
  setCachedMeta('Beta', { value: 2 });
  setCachedMeta('Alpha', { value: 3 });

  setCachedMeta('Gamma', { value: 4 });

  assert.deepEqual(getCachedMeta('Alpha'), { value: 3 });
  assert.equal(getCachedMeta('Beta'), undefined);
  assert.deepEqual(getCachedMeta('Gamma'), { value: 4 });
});

test('metadata cache shares canonically equivalent Unicode keys', () => {
  setCachedMeta('Zoë', { value: 1 });
  assert.deepEqual(getCachedMeta('  ZOE\u0308  '), { value: 1 });
});
