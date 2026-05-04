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
import { claimAndProcessOne } from '../bot/services/scrapeWorker.js';

let mongod;
const silentLogger = { log: () => {}, warn: () => {} };

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

test('claimAndProcessOne processes a pending job and writes back done state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    const job = await ScrapeJob.create({
      url: 'https://example.com/data.json',
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

test('claimAndProcessOne marks job failed when fetch throws', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connect ETIMEDOUT 1.2.3.4:443');
  };

  try {
    const job = await ScrapeJob.create({
      url: 'https://unreachable.example.com/',
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

test('claimAndProcessOne picks the oldest pending job when several are waiting', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('first', { status: 200 });

  try {
    const oldJob = await ScrapeJob.create({
      url: 'https://example.com/a',
      status: 'pending',
      createdAt: new Date(Date.now() - 60_000),
    });
    await ScrapeJob.create({
      url: 'https://example.com/b',
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
    url: 'https://example.com/in-progress',
    status: 'in_progress',
    startedAt: new Date(),
  });
  await ScrapeJob.create({
    url: 'https://example.com/done',
    status: 'done',
    completedAt: new Date(),
    result: { status: 200, headers: {}, body: 'old' },
  });

  const result = await claimAndProcessOne({ logger: silentLogger });
  assert.equal(result.state, 'idle');
});
