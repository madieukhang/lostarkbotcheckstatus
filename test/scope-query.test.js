import test from 'node:test';
import assert from 'node:assert/strict';

import config from '../bot/config.js';
import { buildScopedListQuery } from '../bot/utils/scope.js';

test('non-blacklist queries pass through without scope branches', () => {
  const baseQuery = { name: 'Qiylyn' };

  assert.equal(buildScopedListQuery('white', baseQuery, 'guild-1'), baseQuery);
  assert.equal(buildScopedListQuery('watch', baseQuery, 'guild-1'), baseQuery);
});

test('blacklist queries include global, legacy and requesting-guild scope', () => {
  const baseQuery = { name: 'Qiylyn' };

  assert.deepEqual(buildScopedListQuery('black', baseQuery, 'scope-test-guild'), {
    $and: [
      baseQuery,
      {
        $or: [
          { scope: 'global' },
          { scope: { $exists: false } },
          { scope: 'server', guildId: 'scope-test-guild' },
        ],
      },
    ],
  });
});

test('blacklist queries can preserve legacy empty-guild server scope', () => {
  const baseQuery = { name: 'Qiylyn' };

  assert.deepEqual(
    buildScopedListQuery('black', baseQuery, '', { includeEmptyServerScope: true }),
    {
      $and: [
        baseQuery,
        {
          $or: [
            { scope: 'global' },
            { scope: { $exists: false } },
            { scope: 'server', guildId: '' },
          ],
        },
      ],
    }
  );
});

test('mutation queries can disable the owner visibility bypass', () => {
  const previousOwnerGuildId = config.ownerGuildId;
  const baseQuery = { name: 'Qiylyn' };
  config.ownerGuildId = 'scope-owner-guild';

  try {
    assert.equal(
      buildScopedListQuery('black', baseQuery, 'scope-owner-guild'),
      baseQuery
    );
    assert.deepEqual(
      buildScopedListQuery('black', baseQuery, 'scope-owner-guild', {
        ownerSeesAll: false,
      }),
      {
        $and: [
          baseQuery,
          {
            $or: [
              { scope: 'global' },
              { scope: { $exists: false } },
              { scope: 'server', guildId: 'scope-owner-guild' },
            ],
          },
        ],
      }
    );
  } finally {
    config.ownerGuildId = previousOwnerGuildId;
  }
});
