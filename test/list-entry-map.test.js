import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListEntryMap,
  buildNameRosterQuery,
  sortBlacklistForScopePriority,
} from '../bot/utils/listEntryMap.js';

test('buildNameRosterQuery normalizes scalar and array inputs once', () => {
  assert.deepEqual(
    buildNameRosterQuery(' AltName '),
    {
      $or: [
        { name: { $in: ['AltName'] } },
        { allCharacters: { $in: ['AltName'] } },
      ],
    }
  );

  assert.deepEqual(
    buildNameRosterQuery([' Main ', '', null, 'main', 'Alt']),
    {
      $or: [
        { name: { $in: ['Main', 'Alt'] } },
        { allCharacters: { $in: ['Main', 'Alt'] } },
      ],
    }
  );
});

test('buildNameRosterQuery returns a safe no-match query for empty input', () => {
  assert.deepEqual(
    buildNameRosterQuery(),
    {
      $or: [
        { name: { $in: [] } },
        { allCharacters: { $in: [] } },
      ],
    }
  );
});

test('list entry maps keep server-scoped rows as the highest-priority match', () => {
  const global = { name: 'Main', allCharacters: ['Alt'], scope: 'global' };
  const server = { name: 'Other', allCharacters: ['Alt'], scope: 'server' };
  const rows = sortBlacklistForScopePriority([server, global]);
  const map = buildListEntryMap(rows);

  assert.equal(map.get('alt'), server);
  assert.deepEqual(rows, [global, server]);
});
