/**
 * test/i18n-tpick.test.js
 * Contract tests for the LoaLogs variant picker. The load-bearing one is
 * "bare arrays are not pools": the welcome-pin fields and help groups are
 * arrays meaning "multi-line block", and mistaking one for a pool would render
 * a single random line out of a paragraph with nothing failing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { t, tPick } from '../bot/services/i18n/index.js';
import dialogueEn from '../bot/locales/dialogue/en.js';

test('plain string keys pass straight through to t()', () => {
  const key = 'autoCheckWelcome.title';
  assert.equal(typeof t(key, 'en'), 'string');
  assert.notEqual(t(key, 'en'), key);
  assert.equal(tPick(key, 'en'), t(key, 'en'));
});

test('bare arrays are multi-line blocks, never variant pools', () => {
  const viaT = t('autoCheckWelcome.howValue', 'en');
  assert.ok(Array.isArray(viaT), 'fixture should be a bare array');
  assert.deepEqual(tPick('autoCheckWelcome.howValue', 'en'), viaT);
});

test('a {variants} pool yields one member, selectable by index', () => {
  const key = 'dialogue.cleanupNotice.trivial';
  const pool = dialogueEn.cleanupNotice.trivial.variants;
  const filled = (line) => line.replace('{n}', '3');

  assert.equal(tPick(key, 'en', { n: 3 }, { index: 0 }), filled(pool[0]));
  assert.equal(tPick(key, 'en', { n: 3 }, { index: -1 }), filled(pool.at(-1)));
  assert.equal(tPick(key, 'en', { n: 3 }, { index: pool.length }), filled(pool[0]));
  assert.equal(tPick(key, 'en', { n: 3 }, { random: () => 0.999 }), filled(pool.at(-1)));
});

test('a missing key still degrades to the raw key string', () => {
  assert.equal(tPick('nope.not.a.key', 'en'), 'nope.not.a.key');
});

test('interpolation still applies to a non-pool key', () => {
  const withVars = tPick('dialogue.check.embed.flagged', 'en', { count: 3 });
  assert.equal(typeof withVars, 'string');
  assert.doesNotMatch(withVars, /\{count\}/);
});
