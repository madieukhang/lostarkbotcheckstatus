import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCheckResults } from '../bot/services/list-check/format.js';
import {
  getRosterLookupDescription,
  getRosterLookupEmoji,
  isRosterLookupUnavailable,
} from '../bot/services/list-check/roster-status.js';
import { buildListCheckEmbed } from '../bot/utils/listCheckEmbed.js';

test('ocr list check does not use hidden-roster fallback', () => {
  const serviceSource = readFileSync(
    new URL('../bot/services/list-check/service.js', import.meta.url),
    'utf8'
  );

  assert.match(
    serviceSource,
    /buildRosterCharacters\(item\.name,\s*\{\s*hiddenRosterFallback:\s*false,/s
  );
});

test('list check renders HTTP 403 roster failures as lookup issues', () => {
  const results = [{
    name: 'Blockedname',
    hasRoster: false,
    failReason: 'HTTP 403',
  }];

  const formattedLines = formatCheckResults(results);
  assert.equal(formattedLines.length, 1);
  assert.match(formattedLines[0], /lookup blocked/);
  assert.doesNotMatch(formattedLines[0], /HTTP 403/);

  const { counts, embed } = buildListCheckEmbed({
    results,
    formattedLines,
    limitedNamesCount: 1,
    mode: 'auto',
  });

  assert.equal(counts.lookupIssue, 1);
  assert.equal(counts.noRoster, 0);

  const rendered = embed.toJSON();
  assert.match(rendered.description, /lookup issue/);
  assert.doesNotMatch(rendered.description, /no roster/);
});

test('roster status helpers keep true missing rosters separate from blocked lookups', () => {
  const blocked = { hasRoster: false, failReason: 'HTTP 403' };
  const missing = { hasRoster: false, failReason: 'HTTP 404' };

  assert.equal(isRosterLookupUnavailable(blocked), true);
  assert.equal(isRosterLookupUnavailable(missing), false);
  assert.equal(getRosterLookupDescription(blocked), 'Roster lookup unavailable');
  assert.equal(getRosterLookupDescription(missing), 'No roster found');
  assert.equal(getRosterLookupEmoji(blocked), '⚠️');
  assert.equal(getRosterLookupEmoji(missing), '⚪');
});
