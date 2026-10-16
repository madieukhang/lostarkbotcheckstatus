import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScanResultButtons,
  buildScanResultEmbed,
  deriveScanState,
} from '../bot/utils/scanResultEmbed.js';
import { getClassEmoji } from '../bot/models/Class.js';

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

test('deriveScanState preserves the ordered terminal-state matrix', () => {
  const cases = [
    {
      result: {
        totalEligibleInGuild: 10,
        pausedForFailureStorm: true,
        abortReason: 'system-error',
        cancelled: true,
      },
      stopReason: 'failure-storm',
    },
    {
      result: { totalEligibleInGuild: 10, abortReason: 'system-error', cancelled: true },
      stopReason: 'scan-aborted',
    },
    {
      result: { totalEligibleInGuild: 10, abortReason: 'user-stopped', cancelled: true },
      stopReason: 'stopped',
    },
    {
      result: { totalEligibleInGuild: 10, checkedCandidates: 4 },
      stopReason: 'cap-hit',
    },
    {
      result: { totalEligibleInGuild: 10, checkedCandidates: 10 },
      stopReason: 'completed',
    },
  ];

  for (const { result, stopReason } of cases) {
    assert.equal(deriveScanState(result).stopReason, stopReason);
  }
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

test('scan result embeds name the class of an alt that has only a classId', () => {
  const { embed } = buildScanResultEmbed({
    target: { name: 'Ainslinn', isHidden: false, guildName: 'Bullet Shell' },
    result: {
      totalEligibleInGuild: 1,
      checkedCandidates: 1,
      attemptedCandidates: 1,
      alts: [{ name: 'Idonly', classId: 'berserker_female', itemLevel: 1710 }],
    },
    kind: 'roster-visible',
  });

  const { description } = embed.toJSON();
  assert.ok(description.includes(`${getClassEmoji('Slayer') || 'Slayer'} [Idonly](`));
  assert.ok(!description.includes('berserker_female'));
});

test('scan result button matrix keeps only the actions valid for each state', () => {
  const buttonIds = (options) => (
    buildScanResultButtons({ sessionId: 'session', ...options })
      ?.toJSON().components.map((button) => button.custom_id) ?? []
  );

  assert.deepEqual(buttonIds({ kind: 'enrich', hasAlts: true, hasRemaining: true }), [
    'list-enrich:continue:session',
    'list-enrich:confirm:session',
    'list-enrich:cancel:session',
  ]);
  assert.deepEqual(buttonIds({ kind: 'enrich', hasAlts: false, hasRemaining: true }), [
    'list-enrich:continue:session',
    'list-enrich:cancel:session',
  ]);
  assert.deepEqual(buttonIds({ kind: 'enrich', hasAlts: true, hasRemaining: false }), [
    'list-enrich:confirm:session',
    'list-enrich:cancel:session',
  ]);
  assert.deepEqual(buttonIds({ kind: 'enrich', hasAlts: false, hasRemaining: false }), []);
  assert.deepEqual(buttonIds({ kind: 'roster', hasAlts: false, hasRemaining: true }), [
    'roster-deep:continue:session',
  ]);
  assert.deepEqual(buttonIds({ kind: 'roster', hasAlts: true, hasRemaining: false }), []);
});
