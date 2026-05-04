import test from 'node:test';
import assert from 'node:assert/strict';

import { createWorkerBibleClient } from '../bot/services/roster/workerBibleClient.js';

// Minimal in-memory stand-in for the Mongoose ScrapeJob model. Captures
// the inserted job, exposes a helper to advance its status the way a
// real worker process would, and supports findById().lean().
function buildFakeScrapeJob() {
  let stored = null;
  let initialInsert = null;
  let nextId = 1;

  return {
    // Snapshot of the document at insert time. Useful for assertions
    // about the 'pending' state even after a flipTo('done') has mutated
    // the live record.
    inserted: () => (initialInsert ? { ...initialInsert } : null),
    flipTo(state) {
      if (!stored) throw new Error('No job to flip');
      Object.assign(stored, state);
    },
    async create(payload) {
      stored = {
        _id: `fake-${nextId++}`,
        ...payload,
      };
      initialInsert = { ...stored };
      return stored;
    },
    findById(id) {
      return {
        async lean() {
          if (!stored || stored._id !== id) return null;
          return { ...stored };
        },
      };
    },
  };
}

test('workerBibleClient returns a Response when worker marks job done', async () => {
  const ScrapeJob = buildFakeScrapeJob();
  let nowValue = 0;
  const client = createWorkerBibleClient({
    ScrapeJob,
    pollIntervalMs: 1,
    defaultTimeoutMs: 5_000,
    now: () => nowValue,
  });

  // Schedule the worker-side completion right after the first poll.
  setTimeout(() => {
    ScrapeJob.flipTo({
      status: 'done',
      result: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      },
    });
  }, 5);

  const res = await client.fetch('https://lostark.bible/character/NA/Test/__data.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.deepEqual(await res.json(), { ok: true });

  const inserted = ScrapeJob.inserted();
  assert.equal(inserted.url, 'https://lostark.bible/character/NA/Test/__data.json');
  assert.equal(inserted.status, 'pending');
});

test('workerBibleClient throws when worker marks job failed', async () => {
  const ScrapeJob = buildFakeScrapeJob();
  const client = createWorkerBibleClient({
    ScrapeJob,
    pollIntervalMs: 1,
    defaultTimeoutMs: 5_000,
  });

  setTimeout(() => {
    ScrapeJob.flipTo({ status: 'failed', error: 'connect ETIMEDOUT' });
  }, 5);

  await assert.rejects(
    () => client.fetch('https://lostark.bible/character/NA/Test/__data.json'),
    /Worker fetch failed: connect ETIMEDOUT/,
  );
});

test('workerBibleClient honors the caller timeoutMs hint with a buffer', async () => {
  const ScrapeJob = buildFakeScrapeJob();
  let virtualNow = 0;
  const client = createWorkerBibleClient({
    ScrapeJob,
    pollIntervalMs: 1,
    defaultTimeoutMs: 60_000,
    // Each call to now() advances by 1 second so the polling loop hits
    // the deadline deterministically without real time passing.
    now: () => {
      virtualNow += 1_000;
      return virtualNow;
    },
  });

  await assert.rejects(
    () => client.fetch('https://lostark.bible/character/NA/Test/__data.json', { timeoutMs: 2_000 }),
    /Worker fetch timed out after 7000ms/,
  );
});

test('workerBibleClient strips non-serializable options before insert', async () => {
  const ScrapeJob = buildFakeScrapeJob();
  const client = createWorkerBibleClient({
    ScrapeJob,
    pollIntervalMs: 1,
    defaultTimeoutMs: 1_000,
  });

  setTimeout(() => {
    ScrapeJob.flipTo({
      status: 'done',
      result: { status: 204, headers: {}, body: '' },
    });
  }, 2);

  await client.fetch('https://lostark.bible/character/NA/Test/__data.json', {
    timeoutMs: 1500,
    signal: AbortSignal.timeout(99999),       // must be dropped
    allowScraperApi: true,                     // worker doesn't use it
    preferScraperApi: true,                    // ditto
    fallbackOnRateLimit: true,                 // ditto
  });

  const inserted = ScrapeJob.inserted();
  assert.deepEqual(inserted.options, { timeoutMs: 1500 });
});

test('workerBibleClient surfaces missing job (TTL expired or deleted)', async () => {
  const ScrapeJob = {
    async create(payload) { return { _id: 'ghost-1', ...payload }; },
    findById() { return { async lean() { return null; } }; },
  };

  const client = createWorkerBibleClient({
    ScrapeJob,
    pollIntervalMs: 1,
    defaultTimeoutMs: 5_000,
  });

  await assert.rejects(
    () => client.fetch('https://lostark.bible/character/NA/Ghost/__data.json'),
    /Worker job ghost-1 disappeared/,
  );
});
