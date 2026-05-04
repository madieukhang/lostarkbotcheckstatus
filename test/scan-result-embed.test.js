import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScanResultEmbed,
  deriveScanState,
} from '../bot/utils/scanResultEmbed.js';

test('deriveScanState treats failure storm as paused and leaves failed attempts retryable', () => {
  const state = deriveScanState({
    totalEligibleInGuild: 437,
    checkedCandidates: 0,
    attemptedCandidates: 25,
    failedCandidates: 25,
    pausedForFailureStorm: true,
  });

  assert.deepEqual(state, {
    stopReason: 'failure-storm',
    hasRemaining: true,
    remaining: 437,
  });
});

test('deriveScanState exposes system aborts distinctly from manual stops', () => {
  const state = deriveScanState({
    totalEligibleInGuild: 40,
    checkedCandidates: 10,
    attemptedCandidates: 10,
    abortReason: 'discord-progress-update-failed',
    abortLabel: 'Discord update failed',
  });

  assert.deepEqual(state, {
    stopReason: 'scan-aborted',
    hasRemaining: true,
    remaining: 30,
  });
});

test('scan result embeds surface the latest bible failure reason', () => {
  const { embed } = buildScanResultEmbed({
    target: {
      name: 'Ainslinn',
      isHidden: true,
      guildName: 'Bullet Shell',
    },
    result: {
      totalEligibleInGuild: 437,
      checkedCandidates: 0,
      attemptedCandidates: 25,
      failedCandidates: 25,
      pausedForFailureStorm: true,
      lastFailureReason: 'HTML HTTP 429',
      alts: [],
    },
    kind: 'roster-hidden',
    summaryLine: 'I scanned **Bullet Shell** for stronghold matches with **Ainslinn**.',
  });

  assert.match(embed.toJSON().description, /Last error: `HTML HTTP 429`/);
});
