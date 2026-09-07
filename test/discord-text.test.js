import test from 'node:test';
import assert from 'node:assert/strict';

import { truncateInlineText } from '../bot/utils/discordText.js';

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
