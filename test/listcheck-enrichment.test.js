import test from 'node:test';
import assert from 'node:assert/strict';

import {
  queueFlaggedListEntryEnrichment,
  selectFlaggedItemsForEnrichment,
} from '../bot/services/listCheckEnrichment.js';

test('selectFlaggedItemsForEnrichment returns only flagged list hits and respects limit', () => {
  const black = { name: 'BlackHit', blackEntry: { _id: 'b1', name: 'BlackHit' } };
  const white = { name: 'WhiteHit', whiteEntry: { _id: 'w1', name: 'WhiteHit' } };
  const watch = { name: 'WatchHit', watchEntry: { _id: 'x1', name: 'WatchHit' } };
  const clean = { name: 'Clean', hasRoster: true };

  assert.deepEqual(
    selectFlaggedItemsForEnrichment([black, clean, white, watch], 2),
    [black, white]
  );
  assert.deepEqual(
    selectFlaggedItemsForEnrichment([clean], 2),
    []
  );
});

test('selectFlaggedItemsForEnrichment deduplicates repeated hits for the same entry', () => {
  const sharedEntry = { _id: 'same-entry', name: 'MainHit' };
  const first = { name: 'AltOne', blackEntry: sharedEntry };
  const second = { name: 'AltTwo', blackEntry: sharedEntry };

  assert.deepEqual(
    selectFlaggedItemsForEnrichment([first, second], 10),
    [first]
  );
});

test('queueFlaggedListEntryEnrichment skips Stronghold scan when disabled', () => {
  const result = queueFlaggedListEntryEnrichment(
    [{ name: 'BlackHit', blackEntry: { _id: 'b1', name: 'BlackHit' } }],
    {
      logPrefix: 'test',
      settings: {
        listcheckAltEnrichmentEnabled: false,
        listcheckAltEnrichmentLimit: 1,
      },
    }
  );

  assert.deepEqual(result, { queued: 0, skipped: 1, reason: 'disabled' });
});
