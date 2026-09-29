import test from 'node:test';
import assert from 'node:assert/strict';

import { relativeTime } from '../bot/utils/ui.js';

test('relativeTime renders Discord <t:UNIX:R> format', () => {
  assert.equal(relativeTime(new Date('2026-05-03T10:00:00Z')), '<t:1777802400:R>');
});

test('relativeTime accepts number, Date, and ISO string', () => {
  const ts = 1730000000000;
  const expected = '<t:1730000000:R>';
  assert.equal(relativeTime(ts), expected);
  assert.equal(relativeTime(new Date(ts)), expected);
  assert.equal(relativeTime(new Date(ts).toISOString()), expected);
});

test('relativeTime returns empty string for falsy or unparseable input', () => {
  assert.equal(relativeTime(null), '');
  assert.equal(relativeTime(undefined), '');
  assert.equal(relativeTime(''), '');
  assert.equal(relativeTime('not-a-date'), '');
});
