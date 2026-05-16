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

  // Forbidden = the expensive bible patterns the prior refactor removed:
  // full roster fetch, similar-name search, hidden-roster fallback, and
  // the legacy roster-cache layer. Targeted single-character meta
  // enrichment (fetchCharacterMeta) is intentionally ALLOWED, and the
  // worker-health gate (getWorkerHealth) is ALLOWED because it short-
  // circuits the enrichment when the residential-IP worker is offline.
  for (const forbidden of [
    'buildRosterCharacters',
    'fetchNameSuggestions',
    'RosterCache',
    'buildRosterCacheLookupMap',
    'getRosterCacheMatch',
    'shouldSkipWorkerRosterLookup',
    'hiddenRosterFallback',
    'queueFlaggedListEntryEnrichment',
  ]) {
    assert.doesNotMatch(serviceSource, new RegExp(forbidden));
  }
});

test('ocr list check handlers do not queue post-check roster enrichment', () => {
  const autoCheckSource = readRepoFile('../bot/handlers/list/auto-check.js');
  const slashCheckSource = readRepoFile('../bot/handlers/list/check/index.js');

  // Handlers still must not invoke the heavy post-check pipelines. The
  // single-name meta enrichment lives inside checkNamesAgainstLists (the
  // service layer), not at handler level, so handlers should not need to
  // reference viaWorker / hiddenRosterFallback / queueFlaggedListEntryEnrichment.
  assert.doesNotMatch(autoCheckSource, /queueFlaggedListEntryEnrichment/);
  assert.doesNotMatch(slashCheckSource, /queueFlaggedListEntryEnrichment/);
  assert.doesNotMatch(autoCheckSource, /viaWorker|hiddenRosterFallback/);
  assert.doesNotMatch(slashCheckSource, /viaWorker|hiddenRosterFallback/);
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
  assert.match(formattedLines[0], /CP 4246\.54/);
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
  assert.match(rendered.description, /not listed/);
  assert.match(rendered.footer.text, /database blacklist/);
  assert.doesNotMatch(rendered.description, /lookup issue|no roster|unchecked|worker offline/i);
});
