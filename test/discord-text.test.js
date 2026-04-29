import test from 'node:test';
import assert from 'node:assert/strict';

import { truncateDiscordContent } from '../bot/utils/discordText.js';

test('truncateDiscordContent leaves short content unchanged', () => {
  assert.equal(truncateDiscordContent('short', 20), 'short');
});

test('truncateDiscordContent caps long content with a suffix', () => {
  const result = truncateDiscordContent('x'.repeat(50), 20);

  assert.equal(result.length, 20);
  assert.ok(result.endsWith('... truncated'));
});
