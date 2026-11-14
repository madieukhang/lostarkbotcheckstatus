/**
 * Integration test for the scrape worker iteration logic. Spins up an
 * in-memory MongoDB via `mongodb-memory-server` so the worker can
 * exercise the full Mongoose round trip (insert -> claim -> fetch ->
 * update -> read back) without ever touching production. fetch is
 * stubbed because the goal is to verify worker mechanics + Mongoose
 * Map<>Object header conversion + state transitions, not bible itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

import ScrapeJob from '../bot/models/ScrapeJob.js';
import { createWorkerBibleClient } from '../bot/services/roster/workerBibleClient.js';
import {
  claimAndProcessOne,
  claimNextJob,
  executeJob,
} from '../bot/services/worker/scrape-worker.js';

let mongod;
const silentLogger = { log: () => {}, warn: () => {} };
const MIB = 1024 * 1024;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test.beforeEach(async () => {
  await ScrapeJob.deleteMany({});
});

test('claimAndProcessOne reports idle when no pending jobs', async () => {
  const result = await claimAndProcessOne({ logger: silentLogger });
  assert.equal(result.state, 'idle');
});

test('expired pending jobs do not block a fresh request or get claimed by the worker', async t => {
  const nowMs = Date.now();
  await ScrapeJob.insertMany(Array.from({ length: 100 }, () => ({
    url: 'https://lostark.bible/expired', status: 'pending', deadlineAt: new Date(nowMs - 30_000),
  })));
  assert.equal(await claimNextJob(), null);
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url, 'https://lostark.bible/fresh');
    return new Response('ok', { status: 200 });
  });
  const client = createWorkerBibleClient({
    ScrapeJob: {
      countDocuments: filter => ScrapeJob.countDocuments(filter),
      create: async payload => {
        const job = await ScrapeJob.create(payload);
        await claimAndProcessOne({ logger: silentLogger });
        return job;
      },
      findById: id => ScrapeJob.findById(id),
    },
  });
  const response = await client.fetch('https://lostark.bible/fresh');
  assert.equal(await response.text(), 'ok');
  assert.equal(await ScrapeJob.countDocuments({ status: 'pending' }), 100);
});

test('unexpired and legacy pending jobs still count toward backpressure', async () => {
  await ScrapeJob.insertMany(Array.from({ length: 100 }, (_, index) => ({
    url: 'https://lostark.bible/queued', status: 'pending',
    deadlineAt: index % 2 === 0 ? null : new Date(Date.now() + 60_000),
  })));
  await assert.rejects(
    createWorkerBibleClient({ ScrapeJob }).fetch('https://lostark.bible/fresh'),
    /overloaded: 100 pending jobs/,
  );
  assert.equal(await ScrapeJob.countDocuments(), 100);
});

test('claimAndProcessOne processes a pending job and writes back done state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const job = await ScrapeJob.create({
      url: 'https://lostark.bible/data.json',
      options: { timeoutMs: 5000 },
      status: 'pending',
    });

    const result = await claimAndProcessOne({ logger: silentLogger });
    assert.equal(result.state, 'done');
    assert.equal(result.status, 200);
    assert.equal(result.bodyLength, 11);

    const fresh = await ScrapeJob.findById(job._id).lean();
    assert.equal(fresh.status, 'done');
    assert.equal(fresh.result.status, 200);
    assert.equal(fresh.result.body, '{"ok":true}');
    // Mongoose stores headers as a Map; .lean() returns it as an object.
    const headerObj = fresh.result.headers instanceof Map
      ? Object.fromEntries(fresh.result.headers)
      : fresh.result.headers;
    assert.equal(headerObj['content-type'], 'application/json');
    assert.ok(fresh.startedAt instanceof Date);
    assert.ok(fresh.completedAt instanceof Date);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeJob preserves a successful response with no body', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  const job = await ScrapeJob.create({
    url: 'https://lostark.bible/no-content',
    status: 'in_progress',
    claimId: 'no-content-claim',
  });

  const outcome = await executeJob(job, { logger: silentLogger });

  assert.equal(outcome.state, 'done');
  assert.equal(outcome.status, 204);
  assert.equal(outcome.bodyLength, 0);
  const fresh = await ScrapeJob.findById(job._id).lean();
  assert.equal(fresh.status, 'done');
  assert.equal(fresh.result.body, '');
});

test('claimAndProcessOne marks job failed when fetch throws', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connect ETIMEDOUT 1.2.3.4:443');
  };

  try {
    const job = await ScrapeJob.create({
      url: 'https://lostark.bible/unreachable',
      status: 'pending',
    });

    const result = await claimAndProcessOne({ logger: silentLogger });
    assert.equal(result.state, 'failed');
    assert.match(result.error, /ETIMEDOUT/);

    const fresh = await ScrapeJob.findById(job._id).lean();
    assert.equal(fresh.status, 'failed');
    assert.match(fresh.error, /ETIMEDOUT/);
    assert.equal(fresh.result?.status ?? null, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('executeJob rejects a declared response body that is too large to persist', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('ignored', {
    status: 200,
    headers: { 'content-length': String(24 * MIB) },
  }));
  const job = await ScrapeJob.create({
    url: 'https://lostark.bible/oversized-declared',
    status: 'in_progress',
    claimId: 'declared-claim',
  });

  const outcome = await executeJob(job, { logger: silentLogger });

  assert.equal(outcome.state, 'failed');
  const fresh = await ScrapeJob.findById(job._id).lean();
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.error, /response body is larger than/);
  assert.equal(fresh.result?.body ?? null, null);
});

test('executeJob stops streaming a response once it passes the persistence ceiling', async t => {
  const pulls = { count: 0 };
  const chunk = new Uint8Array(MIB);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      pulls.count += 1;
      if (pulls.count > 24) controller.close();
      else controller.enqueue(chunk);
    },
  }), { status: 200 }));
  const job = await ScrapeJob.create({
    url: 'https://lostark.bible/oversized-stream',
    status: 'in_progress',
    claimId: 'stream-claim',
  });

  const outcome = await executeJob(job, { logger: silentLogger });

  assert.equal(outcome.state, 'failed');
  assert.ok(pulls.count <= 14, `pulled ${pulls.count} MiB`);
  const fresh = await ScrapeJob.findById(job._id).lean();
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.error, /response body is larger than/);
  assert.equal(fresh.result?.body ?? null, null);
});

test('executeJob rejects decoded text that would exceed the persistence ceiling', async t => {
  const invalidUtf8 = new Uint8Array(4 * MIB + 1).fill(0xff);
  t.mock.method(globalThis, 'fetch', async () => new Response(invalidUtf8, { status: 200 }));
  const job = await ScrapeJob.create({
    url: 'https://lostark.bible/expanded-utf8',
    status: 'in_progress',
    claimId: 'expanded-claim',
  });

  const outcome = await executeJob(job, { logger: silentLogger });

  assert.equal(outcome.state, 'failed');
  const fresh = await ScrapeJob.findById(job._id).lean();
  assert.equal(fresh.status, 'failed');
  assert.match(fresh.error, /after UTF-8 decoding/);
  assert.equal(fresh.result?.body ?? null, null);
});

test('claimAndProcessOne picks the oldest pending job when several are waiting', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('first', { status: 200 });

  try {
    const oldJob = await ScrapeJob.create({
      url: 'https://lostark.bible/a',
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000),
    });
    await ScrapeJob.create({
      url: 'https://lostark.bible/b',
      status: 'pending',
      createdAt: new Date(),
    });

    const result = await claimAndProcessOne({ logger: silentLogger });
    assert.equal(result.state, 'done');
    assert.equal(String(result.jobId), String(oldJob._id));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('claimAndProcessOne ignores non-pending jobs', async () => {
  await ScrapeJob.create({
    url: 'https://lostark.bible/in-progress',
    status: 'in_progress',
    startedAt: new Date(),
  });
  await ScrapeJob.create({
    url: 'https://lostark.bible/done',
    status: 'done',
    completedAt: new Date(),
    result: { status: 200, headers: {}, body: 'old' },
  });

  const result = await claimAndProcessOne({ logger: silentLogger });
  assert.equal(result.state, 'idle');
});

test('a reclaimed scrape lease discards the stale worker result', async () => {
  const originalFetch = globalThis.fetch;
  try {
    await ScrapeJob.create({
      url: 'https://lostark.bible/lease',
      status: 'pending',
    });

    const firstClaimAt = Date.parse('2026-08-30T00:00:00Z');
    const oldClaim = await claimNextJob({
      now: () => firstClaimAt,
      staleAfterMs: 1_000,
      claimId: 'old-claim',
    });
    const newClaim = await claimNextJob({
      now: () => firstClaimAt + 1_001,
      staleAfterMs: 1_000,
      claimId: 'new-claim',
    });

    globalThis.fetch = async () => new Response('new-result', { status: 200 });
    assert.equal((await executeJob(newClaim, { logger: silentLogger })).state, 'done');

    globalThis.fetch = async () => new Response('old-result', { status: 200 });
    assert.equal((await executeJob(oldClaim, { logger: silentLogger })).state, 'superseded');

    const fresh = await ScrapeJob.findById(newClaim._id).lean();
    assert.equal(fresh.status, 'done');
    assert.equal(fresh.claimId, 'new-claim');
    assert.equal(fresh.result.body, 'new-result');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scrape worker does not claim an expired pending job', async () => {
  const deadlineAt = new Date('2026-08-30T00:00:00Z');
  await ScrapeJob.create({
    url: 'https://lostark.bible/expired',
    status: 'pending',
    deadlineAt,
  });

  const claim = await claimNextJob({
    now: () => deadlineAt.getTime(),
    claimId: 'should-not-claim',
  });
  assert.equal(claim, null);
});

test('executeJob refuses a URL that is not https://lostark.bible without fetching it', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('should not run'));
  for (const url of ['https://example.com/x', 'http://lostark.bible/x', 'https://lostark.bible.evil.test/x', 'not a url']) {
    const job = await ScrapeJob.create({ url, status: 'in_progress', claimId: `claim-${url}` });
    const outcome = await executeJob(job, { logger: silentLogger });
    assert.equal(outcome.state, 'failed', url);
    const fresh = await ScrapeJob.findById(job._id).lean();
    assert.match(fresh.error, /lostark\.bible/, url);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('executeJob follows a redirect inside lostark.bible and refuses one that leaves it', async t => {
  const asked = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    asked.push(String(url));
    const hops = {
      'https://lostark.bible/a': new Response(null, { status: 301, headers: { location: '/b' } }),
      'https://lostark.bible/b': new Response('{"ok":true}', { status: 200 }),
      'https://lostark.bible/out': new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
    };
    return hops[String(url)] || new Response('unexpected', { status: 500 });
  });
  const inside = await ScrapeJob.create({ url: 'https://lostark.bible/a', status: 'in_progress', claimId: 'redirect-in' });
  assert.equal((await executeJob(inside, { logger: silentLogger })).state, 'done');
  assert.equal((await ScrapeJob.findById(inside._id).lean()).result.body, '{"ok":true}');

  const outside = await ScrapeJob.create({ url: 'https://lostark.bible/out', status: 'in_progress', claimId: 'redirect-out' });
  assert.equal((await executeJob(outside, { logger: silentLogger })).state, 'failed');
  assert.deepEqual(asked, ['https://lostark.bible/a', 'https://lostark.bible/b', 'https://lostark.bible/out']);
});
