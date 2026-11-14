import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import { createRollingQuota } from '../bot/utils/rollingQuota.js';
import { takeEvidenceUploads, resetEvidenceQuota, EVIDENCE_UPLOAD_LIMIT } from '../bot/utils/evidenceQuota.js';

const DAY_MS = 24 * 60 * 60 * 1000;

test('a rolling quota allows its limit, refuses the next one, and frees each slot after the window', () => {
  let now = 0;
  const quota = createRollingQuota({ limit: 3, windowMs: 1000, now: () => now });
  assert.equal(quota.take('a'), true);
  now = 100;
  assert.equal(quota.take('a', 2), true);
  assert.equal(quota.take('a'), false);
  assert.equal(quota.take('b'), true, 'keys are counted apart');
  now = 1001;
  assert.equal(quota.take('a'), true, 'the first slot is free again');
  assert.equal(quota.take('a'), false);
});

test('a rolling quota refuses a batch larger than what is left and takes none of it', () => {
  const quota = createRollingQuota({ limit: 3, windowMs: 1000, now: () => 0 });
  assert.equal(quota.take('a', 2), true);
  assert.equal(quota.take('a', 2), false);
  assert.equal(quota.take('a', 1), true, 'the refused batch consumed nothing');
});

test('a member may archive ten evidence images a day; an approver has no limit', (t) => {
  resetEvidenceQuota();
  t.after(resetEvidenceQuota);
  const officers = config.officerApproverIds;
  config.officerApproverIds = ['officer-1'];
  t.after(() => { config.officerApproverIds = officers; });

  assert.equal(EVIDENCE_UPLOAD_LIMIT, 10);
  assert.equal(takeEvidenceUploads('member-1', 10), true);
  assert.equal(takeEvidenceUploads('member-1', 1), false);
  assert.equal(takeEvidenceUploads('member-2', 1), true);
  assert.equal(takeEvidenceUploads('officer-1', 50), true);
  assert.equal(takeEvidenceUploads('member-1', 0), true, 'a request with no image is never refused');
});

test('the evidence quota window is one day', (t) => {
  let now = 0;
  resetEvidenceQuota({ now: () => now });
  t.after(resetEvidenceQuota);
  assert.equal(takeEvidenceUploads('member-1', 10), true);
  now = DAY_MS - 1;
  assert.equal(takeEvidenceUploads('member-1', 1), false);
  now = DAY_MS + 1;
  assert.equal(takeEvidenceUploads('member-1', 10), true);
});
