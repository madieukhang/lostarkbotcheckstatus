import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCheckResults } from '../bot/services/list-check/format.js';
import { buildListCheckEmbed } from '../bot/utils/listCheckEmbed.js';

function readRepoFile(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

test('ocr list check service avoids the heavy roster ops', () => {
  const serviceSource = readRepoFile('../bot/services/list-check/service.js');

  // The hidden-roster fallback triggers a Stronghold scan per name, which
  // a batch OCR check must not fan out. Targeted single-name enrichment
  // legitimately uses buildRosterCharacters (worker online) or
  // fetchNameSuggestions (worker offline) + getWorkerHealth for routing,
  // so those names are allowed.
  assert.doesNotMatch(serviceSource, /hiddenRosterFallback/);
});

test('ocr list check handlers stay off the worker and hidden-roster paths', () => {
  const autoCheckSource = readRepoFile('../bot/handlers/list/auto-check.js');
  const slashCheckSource = readRepoFile('../bot/handlers/list/check/index.js');

  // The single-name meta enrichment lives inside checkNamesAgainstLists (the
  // service layer), so handlers should not reference viaWorker or
  // hiddenRosterFallback.
  assert.doesNotMatch(autoCheckSource, /viaWorker|hiddenRosterFallback/);
  assert.doesNotMatch(slashCheckSource, /viaWorker|hiddenRosterFallback/);
});

// auto-check-dedupe covers the same option on the auto-check path by behavior.
test('/la-check screenshot path enables targeted diacritic refinement', () => {
  const slashCheckSource = readRepoFile('../bot/handlers/list/check/index.js');

  assert.match(slashCheckSource, /refineAmbiguousDiacritics:\s*true/u);
});

test('unmatched OCR names render as not listed instead of roster lookup status', () => {
  const results = [{
    name: 'Unlistedname',
    blackEntry: null,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: null,
    snapClassName: 'Bard',
    snapItemLevel: 1740.5,
    snapCombatScore: '4246.54',
  }];

  const formattedLines = formatCheckResults(results);
  assert.equal(formattedLines.length, 1);
  assert.match(formattedLines[0], /Unlistedname/);
  assert.match(formattedLines[0], /1740\.50/);
  assert.match(formattedLines[0], /`4246\.54 CP`/);
  assert.doesNotMatch(formattedLines[0], /lookup issue|no roster|unchecked|worker offline/i);

  const { counts, embed } = buildListCheckEmbed({
    results,
    formattedLines,
    limitedNamesCount: 1,
    mode: 'auto',
  });

  assert.deepEqual(counts, {
    black: 0,
    watch: 0,
    white: 0,
    trusted: 0,
    notListed: 1,
  });

  const rendered = embed.toJSON();
  assert.equal(rendered.author.name, '🔎 Here is what I found for the names you sent.');
  assert.equal(rendered.title, undefined);
  assert.equal(rendered.footer, undefined);
  assert.equal(rendered.timestamp, undefined);
  assert.doesNotMatch(rendered.description, /lookup issue|no roster|unchecked|worker offline/i);
});
