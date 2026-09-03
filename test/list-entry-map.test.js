import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildListEntryMap,
  buildListEntryMaps,
  buildNameRosterQuery,
  pickPreferredListEntry,
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

test('list queries and maps dedupe canonically equivalent Unicode names', () => {
  const decomposed = 'Zoe\u0308';
  assert.deepEqual(
    buildNameRosterQuery([decomposed, 'Zoë']),
    {
      $or: [
        { name: { $in: ['Zoë'] } },
        { allCharacters: { $in: ['Zoë'] } },
      ],
    },
  );

  const entry = { name: 'Main', allCharacters: ['Zoë'], scope: 'global' };
  assert.equal(buildListEntryMap([entry]).get('zoë'), entry);
});

test('list entry maps keep server-scoped rows as the highest-priority match without sorting input', () => {
  const global = { name: 'Main', allCharacters: ['Alt'], scope: 'global' };
  const server = { name: 'Other', allCharacters: ['Alt'], scope: 'server' };
  const serverFirst = [server, global];
  const globalFirst = [global, server];

  assert.equal(buildListEntryMaps({ black: serverFirst }).black.get('alt'), server);
  assert.equal(buildListEntryMaps({ black: globalFirst }).black.get('alt'), server);
  assert.deepEqual(serverFirst, [server, global]);
  assert.deepEqual(globalFirst, [global, server]);
});

test('non-blacklist maps keep their first roster match when aliases overlap', () => {
  const first = { name: 'First', allCharacters: ['Shared'] };
  const second = { name: 'Second', allCharacters: ['Shared'] };

  assert.equal(buildListEntryMap([first, second]).get('shared'), first);
});

test('direct names outrank aliases within one scope while server aliases outrank global names', () => {
  const alias = { name: 'Other', allCharacters: ['Shared'], scope: 'global' };
  const direct = { name: 'Shared', allCharacters: [], scope: 'global' };
  const serverAlias = { name: 'Servermain', allCharacters: ['Shared'], scope: 'server' };

  assert.equal(buildListEntryMap([direct, alias]).get('shared'), direct);
  assert.equal(buildListEntryMap([alias, direct]).get('shared'), direct);
  assert.equal(buildListEntryMaps({ black: [direct, serverAlias] }).black.get('shared'), serverAlias);
});

test('requesting-guild blacklist outranks other owner-visible server records in either DB order', () => {
  const ownServer = {
    name: 'Ownmain',
    allCharacters: ['Shared'],
    scope: 'server',
    guildId: 'owner-guild',
    addedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const otherServer = {
    name: 'Shared',
    allCharacters: [],
    scope: 'server',
    guildId: 'other-guild',
    addedAt: new Date('2026-09-01T00:00:00Z'),
  };
  const global = { name: 'Shared', allCharacters: [], scope: 'global' };
  const options = { preferredGuildId: 'owner-guild' };

  assert.equal(
    buildListEntryMaps({ black: [otherServer, global, ownServer] }, options).black.get('shared'),
    ownServer,
  );
  assert.equal(
    buildListEntryMaps({ black: [ownServer, global, otherServer] }, options).black.get('shared'),
    ownServer,
  );
});

test('same-tier owner-visible records resolve newest first with a stable fallback', () => {
  const older = {
    _id: 'b',
    name: 'Older',
    allCharacters: ['Shared'],
    scope: 'server',
    guildId: 'guild-b',
    addedAt: new Date('2026-01-01T00:00:00Z'),
  };
  const newer = {
    _id: 'a',
    name: 'Newer',
    allCharacters: ['Shared'],
    scope: 'server',
    guildId: 'guild-a',
    addedAt: new Date('2026-02-01T00:00:00Z'),
  };
  const options = { preferServerScope: true, preferredGuildId: 'owner-guild' };

  assert.equal(buildListEntryMap([older, newer], options).get('shared'), newer);
  assert.equal(buildListEntryMap([newer, older], options).get('shared'), newer);
});

test('roster-wide selection lets requesting-guild scope outrank an earlier global name', () => {
  const global = { name: 'First', allCharacters: [], scope: 'global' };
  const ownServer = {
    name: 'Servermain',
    allCharacters: ['Second'],
    scope: 'server',
    guildId: 'guild-1',
  };

  assert.equal(pickPreferredListEntry([global, ownServer], ['First', 'Second'], {
    preferServerScope: true,
    preferredGuildId: 'guild-1',
  }), ownServer);
});
