import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLegacyCommandName,
  getLegacyDeprecationBanner,
  HARD_CUTOVER_DATE,
} from '../bot/utils/deprecation.js';

function makeInteraction(commandName, subcommand) {
  return {
    commandName,
    options: {
      getSubcommand: () => subcommand,
    },
  };
}

test('isLegacyCommandName flags every Phase 4 legacy alias', () => {
  for (const legacy of [
    'status',
    'reset',
    'roster',
    'search',
    'list',
    'listcheck',
    'lahelp',
    'lasetup',
    'lastats',
    'laremote',
  ]) {
    assert.equal(isLegacyCommandName(legacy), true, `${legacy} should be legacy`);
  }
});

test('isLegacyCommandName returns false for modern la- names', () => {
  for (const modern of [
    'la-status',
    'la-reset',
    'la-roster',
    'la-search',
    'la-list',
    'la-check',
    'la-help',
    'la-setup',
    'la-stats',
    'la-remote',
  ]) {
    assert.equal(isLegacyCommandName(modern), false, `${modern} should NOT be legacy`);
  }
});

test('isLegacyCommandName returns false for unknown names', () => {
  assert.equal(isLegacyCommandName('totally-unknown'), false);
  assert.equal(isLegacyCommandName(''), false);
  assert.equal(isLegacyCommandName(undefined), false);
});

test('getLegacyDeprecationBanner returns empty string for modern names', () => {
  assert.equal(getLegacyDeprecationBanner(makeInteraction('la-status')), '');
  assert.equal(getLegacyDeprecationBanner(makeInteraction('la-list', 'add')), '');
});

test('getLegacyDeprecationBanner builds banner for top-level legacy names', () => {
  const banner = getLegacyDeprecationBanner(makeInteraction('status'));
  assert.match(banner, /\/status/);
  assert.match(banner, /\/la-status/);
  assert.match(banner, new RegExp(HARD_CUTOVER_DATE));
});

test('getLegacyDeprecationBanner appends /list subcommand to modern target', () => {
  const banner = getLegacyDeprecationBanner(makeInteraction('list', 'add'));
  assert.match(banner, /\/la-list add/);
});

test('getLegacyDeprecationBanner handles /list with no subcommand context safely', () => {
  // Real Discord interactions always carry a subcommand for /list, but
  // the helper must not throw when getSubcommand is unavailable.
  const interaction = {
    commandName: 'list',
    options: {
      getSubcommand: () => {
        throw new Error('no subcommand context');
      },
    },
  };
  const banner = getLegacyDeprecationBanner(interaction);
  // Falls back to bare modern target without the subcommand suffix.
  assert.match(banner, /\/la-list/);
  assert.doesNotMatch(banner, /\/la-list \w/);
});

test('getLegacyDeprecationBanner maps listcheck to la-check', () => {
  const banner = getLegacyDeprecationBanner(makeInteraction('listcheck'));
  assert.match(banner, /\/la-check/);
});

test('HARD_CUTOVER_DATE is 2026-05-17 (Phase 4c target)', () => {
  assert.equal(HARD_CUTOVER_DATE, '2026-05-17');
});
