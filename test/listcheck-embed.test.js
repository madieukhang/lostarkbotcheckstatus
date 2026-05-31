import test from 'node:test';
import assert from 'node:assert/strict';

import { buildListCheckEmbed } from '../bot/utils/listCheckEmbed.js';

// Minimal result objects - buildListCheckEmbed only reads which *Entry is set.
const watch = () => ({ watchEntry: { name: 'A' } });
const trusted = () => ({ trustedEntry: { name: 'B' } });
const unlisted = () => ({});

test('merged header: kicker carries mode + count, title IS the breakdown', () => {
  const results = [watch(), trusted(), trusted(), unlisted(), unlisted(), unlisted(), unlisted(), unlisted()];
  const { embed } = buildListCheckEmbed({
    results,
    formattedLines: ['⚠️ **A** · `1730`', '🛡️ **B** · `1750`'],
    limitedNamesCount: 8,
    mode: 'auto',
  });
  const j = embed.toJSON();
  assert.equal(j.author.name, '// AUTO-CHECK · 8 NAMES');
  // title = the breakdown itself; leading emoji is the strongest outcome present
  assert.equal(j.title, '⚠️ 1 · 🛡️ 2 · ❓ 5 not listed');
  // the old "Outcome:" header line is gone - description leads with the name list
  assert.ok(!j.description.includes('Outcome:'));
  assert.ok(j.description.includes('⚠️ **A**'));
  // footer is a HUD status line + the source citation
  assert.match(j.footer.text, /^\/\/ FLAGGED 1/u);
  assert.match(j.footer.text, /blacklist \+ whitelist \+ watchlist \+ trusted/u);
});

test('slash mode kicker + all-clear footer (0 flagged -> // CLEAR)', () => {
  const results = [trusted(), unlisted()];
  const { embed } = buildListCheckEmbed({
    results,
    formattedLines: ['🛡️ **B**', '❓ C'],
    limitedNamesCount: 2,
    mode: 'slash',
  });
  const j = embed.toJSON();
  assert.equal(j.author.name, '// LIST CHECK · 2 NAMES');
  assert.equal(j.title, '🛡️ 1 · ❓ 1 not listed');
  assert.match(j.footer.text, /^\/\/ CLEAR/u);
});
