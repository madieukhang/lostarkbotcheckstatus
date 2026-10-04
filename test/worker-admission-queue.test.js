import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createWorkerBibleClient } from '../bot/services/roster/workerBibleClient.js';

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function heldAdmission(t, options = {}) {
  let release;
  let started;
  const gate = new Promise(resolve => { release = resolve; });
  const firstCount = new Promise(resolve => { started = resolve; });
  const jobs = [];
  const requests = [];
  let counts = 0;
  const ScrapeJob = {
    async countDocuments() {
      counts++;
      if (counts === 1) {
        started();
        await gate;
      }
      return 0;
    },
    async create(payload) {
      const job = { _id: String(jobs.length + 1), ...payload };
      jobs.push(job);
      return job;
    },
    findById() {
      return { lean: async () => ({ status: 'done', result: { status: 200, body: 'ok' } }) };
    },
    async updateOne() { return { modifiedCount: 1 }; },
  };
  const client = createWorkerBibleClient({ ScrapeJob, ...options });
  const fetch = (name, fetchOptions) => {
    const request = client.fetch(`https://lostark.bible/${name}`, fetchOptions);
    requests.push(request);
    // Every rejected request is observed even if the test fails before cleanup.
    request.catch(() => {});
    return request;
  };
  t.after(async () => {
    release();
    await Promise.allSettled(requests);
  });
  return { fetch, firstCount, release, jobs, count: () => counts };
}

test('worker admission rejects an aborted waiter while an earlier Mongo count is still blocked', async t => {
  const held = heldAdmission(t);
  held.fetch('first');
  await held.firstCount;
  const controller = new AbortController();
  const reason = new Error('scan ended');
  let outcome;
  held.fetch('cancelled', { signal: controller.signal }).catch(error => { outcome = error; });
  controller.abort(reason);
  await nextTurn();

  assert.equal(outcome, reason);
  assert.equal(held.count(), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  held.release();
  await nextTurn();
  assert.deepEqual(held.jobs.map(job => job.url), ['https://lostark.bible/first']);
});

test('worker admission bounds local waiters before they can issue Mongo queries', async t => {
  const held = heldAdmission(t, { maxPendingAdmissions: 3 });
  held.fetch('first');
  await held.firstCount;
  const outcomes = [];
  for (let index = 0; index < 25; index++) {
    held.fetch(`queued-${index}`).catch(error => { outcomes.push(error); });
  }
  await nextTurn();

  assert.equal(outcomes.length, 22);
  assert.ok(outcomes.every(error => /Scraping service overloaded.*queue admission/.test(error.message)));
  assert.equal(held.count(), 1);
  held.release();
  await nextTurn();
  assert.equal(held.jobs.length, 4);
  assert.equal(held.count(), 4);
});

test('worker admission expires a waiter and detaches its listener without waiting for Mongo', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const held = heldAdmission(t, { defaultTimeoutMs: 25 });
  held.fetch('first');
  await held.firstCount;
  const controller = new AbortController();
  let outcome;
  held.fetch('expired', { signal: controller.signal }).catch(error => { outcome = error; });
  t.mock.timers.tick(25);
  await nextTurn();

  assert.match(outcome?.message || '', /timed out before queue admission after 25ms/);
  assert.equal(held.count(), 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  held.release();
  await nextTurn();
  assert.equal(held.jobs.length, 0);
});

test('cancelling worker admission frees capacity and preserves FIFO for surviving waiters', async t => {
  const held = heldAdmission(t, { maxPendingAdmissions: 2 });
  held.fetch('first');
  await held.firstCount;
  const controller = new AbortController();
  const cancelled = held.fetch('cancelled', { signal: controller.signal });
  let cancellation;
  cancelled.catch(error => { cancellation = error; });
  held.fetch('second');
  controller.abort();
  const third = held.fetch('third');
  await nextTurn();
  assert.equal(cancellation?.name, 'AbortError');
  held.release();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await third).status, 200);

  assert.deepEqual(held.jobs.map(job => job.url), [
    'https://lostark.bible/first',
    'https://lostark.bible/second',
    'https://lostark.bible/third',
  ]);
});

test('failed worker admission releases its slot for the next waiter', async t => {
  const held = heldAdmission(t, { maxPendingAdmissions: 1 });
  const controller = new AbortController();
  const first = held.fetch('first', { signal: controller.signal });
  await held.firstCount;
  const next = held.fetch('next');
  controller.abort();
  held.release();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal((await next).status, 200);
  assert.deepEqual(held.jobs.map(job => job.url), ['https://lostark.bible/next']);
});
