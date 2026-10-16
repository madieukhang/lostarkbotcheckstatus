import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScanResultButtons,
  buildScanResultEmbed,
  deriveScanState,
  describeScanAbort,
} from '../bot/utils/scanResultEmbed.js';
import { getClassEmoji } from '../bot/models/Class.js';
import { t } from '../bot/services/i18n/index.js';
import { ENGLISH_ABORT_TEXT } from './helpers/english-abort-text.js';

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

// A real result reaches the aborted hint only with a system abort code; the
// user-stop and failure-storm codes render their own hints on the card. The
// detector sets the failure-storm code together with `pausedForFailureStorm`.
const ABORT_CODE_CASES = [
  { abortReason: 'user-stopped', extra: { cancelled: true } },
  { abortReason: 'discord-progress-update-failed', extra: { cancelled: true }, key: 'discordUpdateFailed' },
  { abortReason: 'bible-failure-storm', extra: { pausedForFailureStorm: true } },
  { abortReason: 'unmapped-code', extra: { cancelled: true }, fallback: true },
];

for (const { abortReason, extra, key, fallback } of ABORT_CODE_CASES) {
  test(`vi scan card for ${abortReason}${extra.pausedForFailureStorm ? ' (paused)' : ''} carries no English abort text`, () => {
    const { embed } = buildScanResultEmbed({
      target: { name: 'Ainslinn', isHidden: false, guildName: 'Bullet Shell' },
      result: {
        totalEligibleInGuild: 40,
        checkedCandidates: 10,
        attemptedCandidates: 14,
        failedCandidates: 4,
        lastFailureReason: 'HTML HTTP 503',
        abortReason,
        ...extra,
      },
      kind: 'roster-visible',
      lang: 'vi',
    });

    const { description } = embed.toJSON();
    for (const english of ENGLISH_ABORT_TEXT) assert.ok(!description.includes(english), english);
    if (key) {
      const base = `dialogue.scan.result.abortReasons.${key}`;
      assert.ok(description.includes(t(`${base}.label`, 'vi')), description);
    }
    if (fallback) assert.ok(description.includes(t('dialogue.scan.result.issue', 'vi')), description);
  });
}

for (const lang of ['en', 'vi', 'jp']) {
  test(`describeScanAbort explains only the Discord update failure with a detail in ${lang}`, () => {
    const reasons = 'dialogue.scan.result.abortReasons';
    for (const [abortReason, key] of [['user-stopped', 'userStopped'], ['bible-failure-storm', 'bibleFailureStorm']]) {
      assert.deepEqual(describeScanAbort({ abortReason }, lang), {
        label: t(`${reasons}.${key}.label`, lang),
        detail: '',
      }, abortReason);
    }

    const discord = describeScanAbort({ abortReason: 'discord-progress-update-failed' }, lang);
    assert.equal(discord.label, t(`${reasons}.discordUpdateFailed.label`, lang));
    assert.equal(discord.detail, t(`${reasons}.discordUpdateFailed.detail`, lang));
    assert.notEqual(discord.detail, '');

    for (const result of [{ abortReason: 'unmapped-code' }, {}]) {
      assert.deepEqual(describeScanAbort(result, lang), {
        label: t('dialogue.scan.result.issue', lang),
        detail: '',
      }, JSON.stringify(result));
    }
  });
}

test('the failure-storm hint carries the attempt counts, rate and last error', () => {
  const { embed } = buildScanResultEmbed({
    target: { name: 'Ainslinn', isHidden: false },
    result: {
      totalEligibleInGuild: 40,
      checkedCandidates: 10,
      attemptedCandidates: 14,
      failedCandidates: 4,
      lastFailureReason: 'HTML HTTP 503',
      abortReason: 'bible-failure-storm',
      pausedForFailureStorm: true,
    },
    kind: 'roster-visible',
  });

  const { description } = embed.toJSON();
  assert.ok(description.includes('Bible rejected 4/14 profiles (29%)'), description);
  assert.ok(description.includes('Last error: `HTML HTTP 503`.'), description);
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
