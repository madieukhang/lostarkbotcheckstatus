import test from 'node:test';
import assert from 'node:assert/strict';

import { pickEvidenceEntry } from '../bot/handlers/search/evidence.js';
import { buildSearchResultEmbed } from '../bot/handlers/search/ui.js';

test('search summary counts clean results without double-subtracting multi-status hits', () => {
  const embed = buildSearchResultEmbed({
    name: 'Ains',
    minIlvl: 1700,
    maxIlvl: null,
    classFilter: null,
    results: [
      {
        name: 'Ainslinn',
        cls: 'bard',
        itemLevel: 1700,
        black: { name: 'Ainslinn', reason: 'bad' },
        white: null,
        watch: null,
        trusted: { name: 'Ainslinn', reason: 'known' },
      },
      {
        name: 'Cleanalt',
        cls: 'bard',
        itemLevel: 1700,
        black: null,
        white: null,
        watch: null,
        trusted: null,
      },
    ],
  });

  const description = embed.toJSON().description;
  assert.match(description, /Found \*\*2\*\* matches:/);
  assert.match(description, /⛔ \*\*1\*\*/);
  assert.match(description, /🛡️ \*\*1\*\*/);
  assert.match(description, /❓ \*\*1\*\* clean/);
});

test('search evidence picker skips earlier list entries without images', () => {
  const watchEntry = { name: 'Ainslinn', reason: 'watch', imageMessageId: '123' };
  const result = {
    name: 'Ainslinn',
    black: { name: 'Ainslinn', reason: 'black-no-image' },
    white: null,
    watch: watchEntry,
  };

  assert.equal(pickEvidenceEntry(result), watchEntry);
});
