import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const [{ default: Blacklist }, { default: Whitelist }, { default: Watchlist }] = await Promise.all([
  import('../bot/models/Blacklist.js'),
  import('../bot/models/Whitelist.js'),
  import('../bot/models/Watchlist.js'),
]);

const COMMON_PATHS = [
  'name',
  'reason',
  'raid',
  'logsUrl',
  'imageUrl',
  'imageMessageId',
  'imageChannelId',
  'allCharacters',
  'enrichmentSource',
  'enrichedAt',
  'addedByUserId',
  'addedByTag',
  'addedByName',
  'addedByDisplayName',
  'addedAt',
];

function findIndex(model, expectedKeys) {
  return model.schema.indexes().find(([keys]) => (
    JSON.stringify(keys) === JSON.stringify(expectedKeys)
  ));
}

test('list entry models preserve one common document shape', () => {
  for (const model of [Blacklist, Whitelist, Watchlist]) {
    for (const path of COMMON_PATHS) {
      assert.ok(model.schema.path(path), `${model.modelName} missing ${path}`);
    }
    assert.equal(model.schema.path('name').options.required, true);
    assert.equal(model.schema.path('name').options.trim, true);
    assert.deepEqual(model.schema.path('allCharacters').options.default, []);
  }

  assert.notEqual(Blacklist.schema, Whitelist.schema);
  assert.notEqual(Whitelist.schema, Watchlist.schema);
});

test('only blacklist entries carry server scope fields', () => {
  assert.ok(Blacklist.schema.path('scope'));
  assert.ok(Blacklist.schema.path('guildId'));
  assert.equal(Blacklist.schema.path('scope').options.default, 'global');
  assert.deepEqual(Blacklist.schema.path('scope').options.enum, ['global', 'server']);

  for (const model of [Whitelist, Watchlist]) {
    assert.equal(model.schema.path('scope'), undefined);
    assert.equal(model.schema.path('guildId'), undefined);
  }
});

test('list entry indexes keep current uniqueness and roster lookup contracts', () => {
  const blackUnique = findIndex(Blacklist, { name: 1, scope: 1, guildId: 1 });
  assert.deepEqual(blackUnique?.[1], {
    unique: true,
    collation: { locale: 'en', strength: 2 },
  });

  for (const model of [Whitelist, Watchlist]) {
    const unique = findIndex(model, { name: 1 });
    assert.deepEqual(unique?.[1], {
      unique: true,
      collation: { locale: 'en', strength: 2 },
    });
  }

  for (const model of [Blacklist, Whitelist, Watchlist]) {
    assert.deepEqual(findIndex(model, { allCharacters: 1 })?.[1], {});
  }
});

test('list entry model and collection names remain stable', () => {
  assert.deepEqual(
    [Blacklist, Whitelist, Watchlist].map((model) => [model.modelName, model.collection.name]),
    [
      ['blacklist', 'blacklist'],
      ['whitelist', 'whitelist'],
      ['watchlist', 'watchlist'],
    ]
  );
});
