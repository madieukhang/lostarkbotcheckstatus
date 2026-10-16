import test from 'node:test';
import assert from 'node:assert/strict';

import { makeRosterScanProgressCallback } from '../bot/handlers/roster/progress.js';
import { getClassEmoji } from '../bot/models/Class.js';
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
  callback({ ...progress, attemptedCandidates: 10, failedCandidates: 10 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  lastEditRef.value = 0;
  callback({ ...progress, attemptedCandidates: 15, failedCandidates: 15 });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(cancelFlag, { cancelled: true, reason: 'discord-progress-update-failed' });
});

test('scan progress embed surfaces the latest bible failure reason', () => {
  const embed = buildScanProgressEmbed({
    title: 'Stronghold scan in progress - Ainslinn',
    subtitle: 'Guild **Bullet Shell**',
    progress: {
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

const scanProgress = alts => ({
  attemptedCandidates: 20,
  checkedCandidates: 20,
  totalCandidates: 437,
  failedCandidates: 0,
  altsFound: alts.length,
  currentBackoffMs: 8000,
  alts,
});

test('scan progress embed escapes a closing bracket in an alt name', () => {
  const embed = buildScanProgressEmbed({
    title: 'Stronghold scan in progress - Ainslinn',
    progress: scanProgress([{ name: 'Odd]Name', itemLevel: 1710 }]),
  });

  assert.ok(embed.toJSON().description.includes(String.raw`[Odd\]Name](`));
});

test('scan progress embed shows the CP badge on an alt row', () => {
  const embed = buildScanProgressEmbed({
    title: 'Stronghold scan in progress - Ainslinn',
    progress: scanProgress([{ name: 'Strongalt', itemLevel: 1710, combatScore: '2500' }]),
  });

  assert.ok(embed.toJSON().description.includes('`1710.00` · `2500 CP`'));
});

test('scan progress embed names the class of an alt that has only a classId', () => {
  const embed = buildScanProgressEmbed({
    title: 'Stronghold scan in progress - Ainslinn',
    progress: scanProgress([{ name: 'Idonly', classId: 'berserker_female', itemLevel: 1710 }]),
  });

  const { description } = embed.toJSON();
  assert.ok(description.includes(`${getClassEmoji('Slayer') || 'Slayer'} [Idonly](`));
  assert.ok(!description.includes('berserker_female'));
});

test('scan progress embed lists at most 12 alt rows', () => {
  const alts = Array.from({ length: 13 }, (_, i) => ({ name: `Alt${i}`, itemLevel: 1700 + i }));
  const embed = buildScanProgressEmbed({
    title: 'Stronghold scan in progress - Ainslinn',
    progress: scanProgress(alts),
  });

  const { description } = embed.toJSON();
  assert.equal(description.match(/\]\(/g).length, 12);
  assert.ok(description.includes('Alt11'));
  assert.ok(!description.includes('Alt12'));
});
