import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListMatchCandidates,
  didListCheckNameChange,
  resolveMappedListMatch,
} from '../bot/services/list-check/matchResolution.js';

test('final list candidates keep the canonical name first and de-duplicate roster alts', () => {
  const item = {
    inputName: 'Altchxr',
    name: 'Altchar',
    discoveredAlts: ['Altchar', 'Rosteralt', 'ROSTERALT', 'Mainchar'],
  };

  assert.equal(didListCheckNameChange(item), true);
  assert.deepEqual(buildListMatchCandidates(item), [
    { name: 'Altchar', origin: 'checked' },
    { name: 'Rosteralt', origin: 'roster' },
    { name: 'Mainchar', origin: 'roster' },
  ]);
  assert.equal(didListCheckNameChange({ inputName: 'ALTCHAR', name: 'Altchar' }), false);
});

test('mapped list matches distinguish direct, tracked-alt, and discovered-roster paths', () => {
  const entry = { name: 'Mainchar', allCharacters: ['Mainchar', 'Trackedalt'] };
  const map = new Map([
    ['mainchar', entry],
    ['trackedalt', entry],
    ['rosteralt', entry],
  ]);

  assert.deepEqual(
    resolveMappedListMatch(map, [{ name: 'Mainchar', origin: 'checked' }]).detail,
    { kind: 'direct', matchedName: 'Mainchar' },
  );
  assert.deepEqual(
    resolveMappedListMatch(map, [{ name: 'Trackedalt', origin: 'checked' }]).detail,
    { kind: 'tracked', matchedName: 'Trackedalt' },
  );
  assert.deepEqual(
    resolveMappedListMatch(map, [{ name: 'Rosteralt', origin: 'roster' }]).detail,
    { kind: 'roster', matchedName: 'Rosteralt' },
  );
});

test('mapped list resolution returns an explicit empty result when final candidates do not match', () => {
  assert.deepEqual(
    resolveMappedListMatch(new Map(), [{ name: 'Correctedname', origin: 'checked' }]),
    { entry: null, detail: null },
  );
});
