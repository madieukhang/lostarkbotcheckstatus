import test from 'node:test';
import assert from 'node:assert/strict';

import { COLORS } from '../bot/utils/ui.js';
import { buildListCheckEmbed } from '../bot/utils/listCheckEmbed.js';

// Characterization guard: the check-card color must resolve from the shared
// COLORS tokens, not duplicated inline hexes. Locks intent so a future token
// change can't silently drift the card away from the rest of the palette.
const build = (results) => buildListCheckEmbed({
  results,
  // Discord builders reject an empty description, so mirror production where
  // every checked name yields a formatted line.
  formattedLines: results.map((_, i) => `- name${i}`),
  limitedNamesCount: results.length,
  mode: 'slash',
  lang: 'en',
}).embed.toJSON();

test('check-card color resolves from COLORS tokens', () => {
  assert.equal(build([{ blackEntry: {} }]).color, COLORS.danger);
  assert.equal(build([{ watchEntry: {} }]).color, COLORS.warning);
  assert.equal(build([{ whiteEntry: {} }]).color, COLORS.success);
  assert.equal(build([{ trustedEntry: {} }]).color, COLORS.success);
  assert.equal(build([{}]).color, COLORS.info);
});
