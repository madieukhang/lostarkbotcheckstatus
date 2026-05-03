import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLORS,
  ICONS,
  relativeTime,
  absoluteTime,
  buildSessionFooter,
  buildCooldownLines,
} from '../bot/utils/ui.js';

test('COLORS exposes the full Discord-native + trusted palette', () => {
  for (const key of ['success', 'warning', 'info', 'danger', 'muted', 'trusted']) {
    assert.equal(typeof COLORS[key], 'number', `COLORS.${key} should be a hex number`);
  }
});

test('COLORS palette matches Discord brand hex codes', () => {
  assert.equal(COLORS.success, 0x57f287);
  assert.equal(COLORS.warning, 0xfee75c);
  assert.equal(COLORS.info,    0x5865f2);
  assert.equal(COLORS.danger,  0xed4245);
});

test('ICONS exposes severity, status, action, and persona buckets', () => {
  // severity
  assert.equal(typeof ICONS.done, 'string');
  assert.equal(typeof ICONS.warn, 'string');
  assert.equal(typeof ICONS.error, 'string');
  // status
  assert.equal(typeof ICONS.ready, 'string');
  assert.equal(typeof ICONS.partial, 'string');
  // action
  assert.equal(typeof ICONS.search, 'string');
  assert.equal(typeof ICONS.evidence, 'string');
  // persona
  assert.equal(ICONS.fox, '🦊');
});

test('relativeTime renders Discord <t:UNIX:R> format', () => {
  const fixed = new Date('2026-05-03T10:00:00Z');
  assert.equal(relativeTime(fixed), `<t:${Math.floor(fixed.getTime() / 1000)}:R>`);
});

test('relativeTime accepts number, Date, and ISO string', () => {
  const ts = 1730000000000;
  const expected = `<t:${Math.floor(ts / 1000)}:R>`;
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

test('absoluteTime renders Discord <t:UNIX:f> format', () => {
  const fixed = new Date('2026-05-03T10:00:00Z');
  assert.equal(absoluteTime(fixed), `<t:${Math.floor(fixed.getTime() / 1000)}:f>`);
  assert.equal(absoluteTime(null), '');
});

test('buildSessionFooter renders the canonical session line', () => {
  assert.equal(buildSessionFooter(5), 'Session 5m · only you can act');
  assert.equal(
    buildSessionFooter(3, 'officer only'),
    'Session 3m · officer only'
  );
});

test('buildCooldownLines stacks lines with newlines and drops empties', () => {
  assert.equal(buildCooldownLines('a', '', 'b', null, 'c'), 'a\nb\nc');
  assert.equal(buildCooldownLines(), '');
  assert.equal(buildCooldownLines('only one'), 'only one');
});
