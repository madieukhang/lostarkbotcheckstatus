import test from 'node:test';
import assert from 'node:assert/strict';

import { createLruTtlCache } from '../bot/utils/cache/lruTtlCache.js';

test('LRU TTL cache expires lazily and refreshes recency on reads', () => {
  let currentTime = 100;
  const cache = createLruTtlCache({
    ttlMs: 10,
    maxSize: 2,
    now: () => currentTime,
    normalizeKey: (key) => String(key || '').toLowerCase(),
  });

  cache.set('Alpha', { value: 1 });
  cache.set('Beta', { value: 2 });
  assert.deepEqual(cache.get('ALPHA'), { value: 1 });

  cache.set('Gamma', { value: 3 });
  assert.equal(cache.get('Beta'), undefined);
  assert.deepEqual(cache.get('Gamma'), { value: 3 });

  currentTime = 111;
  assert.equal(cache.get('Alpha'), undefined);
});

test('updating an existing key at capacity does not evict another entry', () => {
  const cache = createLruTtlCache({ ttlMs: 100, maxSize: 2 });
  cache.set('alpha', 1);
  cache.set('beta', 2);
  cache.set('beta', 3);

  assert.equal(cache.get('alpha'), 1);
  assert.equal(cache.get('beta'), 3);
});

test('cloneValue isolates cached arrays on both writes and reads', () => {
  const cache = createLruTtlCache({
    ttlMs: 100,
    maxSize: 2,
    cloneValue: (values) => [...values],
  });
  const source = ['Alpha'];
  cache.set('names', source);
  source.push('Beta');

  const firstRead = cache.get('names');
  firstRead.push('Gamma');

  assert.deepEqual(cache.get('names'), ['Alpha']);
});

for (const writeKey of ['delta', 'gamma']) {
  test(`lowering the dynamic size limit trims the cache when writing ${writeKey}`, () => {
    let maxSize = 3;
    const cache = createLruTtlCache({ ttlMs: 100, maxSize: () => maxSize });
    cache.set('alpha', 1);
    cache.set('beta', 2);
    cache.set('gamma', 3);

    maxSize = 1;
    cache.set(writeKey, 4);

    assert.equal(cache.get('alpha'), undefined);
    assert.equal(cache.get('beta'), undefined);
    if (writeKey !== 'gamma') assert.equal(cache.get('gamma'), undefined);
    assert.equal(cache.get(writeKey), 4);
  });
}
