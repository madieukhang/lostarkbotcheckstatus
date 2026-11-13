import test from 'node:test';
import assert from 'node:assert/strict';

import { cutChoiceText, escapeEmbedText, truncateInlineText } from '../bot/utils/discordText.js';

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
