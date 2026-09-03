import test from 'node:test';
import assert from 'node:assert/strict';

import { createLatestOnlyQueue } from '../bot/utils/async.js';

test('latest-only queue coalesces overlapping renders and keeps the newest state', async () => {
  let state = 1;
  let releaseFirst;
  const firstRunGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const renderedStates = [];
  const labelBatches = [];
  let runCount = 0;

  const queue = createLatestOnlyQueue(async (labels) => {
    runCount += 1;
    const captured = state;
    if (runCount === 1) await firstRunGate;
    renderedStates.push(captured);
    labelBatches.push(labels);
  });

  const first = queue.request('initial');
  await Promise.resolve();
  state = 2;
  const second = queue.request('page');
  state = 3;
  const third = queue.request('icons');
  releaseFirst();

  await Promise.all([first, second, third, queue.flush()]);

  assert.deepEqual(renderedStates, [1, 3]);
  assert.deepEqual(labelBatches, [['initial'], ['page', 'icons']]);
});

test('latest-only queue reports a failed run and remains usable', async () => {
  const errors = [];
  let shouldThrow = true;
  let successfulRuns = 0;
  const queue = createLatestOnlyQueue(async () => {
    if (shouldThrow) throw new Error('render failed');
    successfulRuns += 1;
  }, {
    onError: (err, labels) => errors.push({ message: err.message, labels }),
  });

  await queue.request('broken');
  shouldThrow = false;
  await queue.request('recovered');

  assert.deepEqual(errors, [{ message: 'render failed', labels: ['broken'] }]);
  assert.equal(successfulRuns, 1);
});
