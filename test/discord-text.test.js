import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cutChoiceText,
  cutText,
  escapeEmbedText,
  storedText,
  truncateInlineText,
} from '../bot/utils/discordText.js';

test('cutChoiceText keeps a choice within 100 units without splitting an emoji', () => {
  assert.equal(cutChoiceText('short'), 'short');
  assert.equal(cutChoiceText(`${'x'.repeat(98)}😀z`), `${'x'.repeat(98)}😀`);
  assert.equal(cutChoiceText(`${'x'.repeat(99)}😀`), 'x'.repeat(99));
});

test('escapeEmbedText escapes markdown and masked-link brackets once', () => {
  assert.equal(escapeEmbedText('[x](https://a.b) **b**'), '\\[x\\](https://a.b) \\*\\*b\\*\\*');
  assert.equal(escapeEmbedText('Plain Guild'), 'Plain Guild');
});

test('truncateInlineText trims labels and preserves short values', () => {
  assert.equal(truncateInlineText('  short  ', 20), 'short');
  assert.equal(truncateInlineText(null, 20), '');
  assert.equal(truncateInlineText(123, 20), '123');
});

test('truncateInlineText reserves suffix space within Discord label limits', () => {
  const result = truncateInlineText('x'.repeat(50), 20);
  assert.equal(result.length, 20);
  assert.ok(result.endsWith('...'));
  assert.equal(truncateInlineText('abcdef', 4, '…'), 'abc…');
  assert.equal(truncateInlineText('abcdef', 2), 'ab');
});

test('cutText keeps at most the limit and ends on a whole character', () => {
  assert.equal(cutText('abcdef', 3), 'abc');
  assert.equal(cutText('ab😀cd', 3), 'ab');
  assert.equal(cutText('ab😀cd', 4), 'ab😀');
  assert.equal(cutText('short', 20), 'short');
  assert.equal(cutText(null, 5), '');
});

test('truncateInlineText never ends its cut on half an emoji', () => {
  // 20 - 3 for the suffix lands inside the first emoji.
  assert.equal(truncateInlineText(`${'x'.repeat(16)}${'😀'.repeat(10)}`, 20), `${'x'.repeat(16)}...`);
  // A limit no longer than the suffix cuts without one.
  assert.equal(truncateInlineText('a😀b', 2), 'a');
});

test('storedText cuts a reason full of emoji on a whole character', () => {
  const cut = storedText(`griefed raids ${'😡'.repeat(40)}`, 80);
  assert.ok(cut.isWellFormed(), JSON.stringify(cut));
  assert.ok(cut.length <= 80);
  assert.ok(cut.endsWith('😡...'), JSON.stringify(cut));
});
