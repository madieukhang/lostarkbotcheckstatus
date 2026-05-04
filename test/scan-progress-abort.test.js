import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRosterScanProgressCallback } from '../bot/handlers/roster/progress.js';
import { buildScanProgressEmbed } from '../bot/utils/scanProgressEmbed.js';

test('roster progress callback aborts scan after repeated message edit failures', async () => {
  const cancelFlag = { cancelled: false };
  const lastEditRef = { value: 0 };
  const callback = makeRosterScanProgressCallback({
    interaction: {},
    replyEditor: {
      edit: async () => {
        throw new Error('Invalid Webhook Token');
      },
    },
    name: 'Ainslinn',
    meta: { guildName: 'Bullet Shell' },
    totalMembers: 819,
    startedAtRef: { value: Date.now() - 60_000 },
    lastEditRef,
    cancelFlag,
    sessionId: 'scan1',
  });

  const progress = {
    scannedCandidates: 5,
    attemptedCandidates: 5,
    checkedCandidates: 0,
    totalCandidates: 437,
    failedCandidates: 5,
    altsFound: 0,
    currentBackoffMs: 8000,
  };

  callback(progress);
  await new Promise((resolve) => setTimeout(resolve, 10));
  lastEditRef.value = 0;
  callback({ ...progress, scannedCandidates: 10, attemptedCandidates: 10, failedCandidates: 10 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  lastEditRef.value = 0;
  callback({ ...progress, scannedCandidates: 15, attemptedCandidates: 15, failedCandidates: 15 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(cancelFlag.cancelled, true);
  assert.equal(cancelFlag.reason, 'discord-progress-update-failed');
  assert.equal(cancelFlag.label, 'Discord update failed');
});

test('scan progress embed surfaces the latest bible failure reason', () => {
  const embed = buildScanProgressEmbed({
    title: 'Stronghold scan in progress - Ainslinn',
    subtitle: 'Guild **Bullet Shell**',
    progress: {
      scannedCandidates: 20,
      attemptedCandidates: 20,
      checkedCandidates: 0,
      totalCandidates: 437,
      failedCandidates: 20,
      altsFound: 0,
      currentBackoffMs: 8000,
      lastFailureReason: 'HTML HTTP 403',
    },
  });

  assert.match(embed.toJSON().description, /Last error: `HTML HTTP 403`/);
});
