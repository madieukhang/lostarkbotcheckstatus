import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { resolveRosterWorld } = await import('../bot/handlers/list/trackedAltsRender.js');
const { buildCheckEntryDetailsEmbed } = await import('../bot/handlers/list/check/ui.js');
const { buildBroadcastFields, mergeRosterStatRecords } = await import('../bot/handlers/list/services/broadcasts.js');
const { buildListAddSuccessFields } = await import('../bot/handlers/list/services/addExecutor.js');
const { statMapFromRosterCharacters } = await import('../bot/handlers/list/trackedAltsRender.js');
const { buildEvidenceEmbed } = await import('../bot/handlers/list/view/ui.js');
const { decorateListEntry } = await import('../bot/handlers/list/helpers.js');

const ZWSP = '​';

const ENTRY = {
  name: 'Tenshi',
  reason: 'Griefing report',
  raid: 'Kazeros Hard',
  addedAt: new Date('2026-08-30T00:00:00Z'),
  allCharacters: ['Tenshi', 'Hanako', 'Mikazuki'],
  scope: 'global',
};

const serverValue = (fields) =>
  fields.find((field) => field.name.includes('Server'))?.value;

test('the entry own snapshot wins when it knows the server', () => {
  const statMap = new Map([
    ['tenshi', { name: 'Tenshi', world: 'Thaemine' }],
    ['hanako', { name: 'Hanako', world: 'Elpon' }],
  ]);

  assert.equal(resolveRosterWorld(ENTRY, statMap), 'Thaemine');
});

test('a sibling answers when the entry own snapshot has no server', () => {
  // The common case: this row was written before the field existed, or
  // came from the name-search route, which cannot report a server at all.
  const statMap = new Map([
    ['tenshi', { name: 'Tenshi', itemLevel: 1770 }],
    ['hanako', { name: 'Hanako', world: 'Thaemine' }],
  ]);

  assert.equal(resolveRosterWorld(ENTRY, statMap), 'Thaemine');
});

test('resolution reports nothing rather than guessing when no sibling knows', () => {
  const statMap = new Map([
    ['tenshi', { name: 'Tenshi', itemLevel: 1770 }],
    ['hanako', { name: 'Hanako', world: '   ' }],
  ]);

  assert.equal(resolveRosterWorld(ENTRY, statMap), '');
  assert.equal(resolveRosterWorld(ENTRY, new Map()), '');
  assert.equal(resolveRosterWorld(null), '');
});

test('the check detail card reads the server across the roster', () => {
  const statMap = new Map([
    ['tenshi', { name: 'Tenshi', classId: 'bard', itemLevel: 1770, combatScore: '≈4903.06' }],
    ['mikazuki', { name: 'Mikazuki', world: 'Thaemine' }],
  ]);
  const fields = buildCheckEntryDetailsEmbed(
    decorateListEntry(ENTRY, 'black'),
    { lang: 'vi', statMap }
  ).toJSON().fields;

  // Tenshi has class + ilvl + CP already, so enrichment never fetches for
  // that name again · without the roster read this field stayed empty
  // forever.
  assert.equal(serverValue(fields), '`Thaemine`');
});

test('the broadcast card reads the server across the roster too', () => {
  const statMap = new Map([
    ['tenshi', { name: 'Tenshi', itemLevel: 1770, combatScore: '≈4903.06' }],
    ['hanako', { name: 'Hanako', world: 'Elpon' }],
  ]);
  const fields = buildBroadcastFields({
    entry: ENTRY,
    action: 'added',
    snap: statMap.get('tenshi'),
    lang: 'vi',
    statMap,
  });

  assert.equal(serverValue(fields), '`Elpon`');
});

test('the la-roster hit card carries Server and stays at five fields', () => {
  // This is the card /la-roster puts above the roster it just fetched.
  // It had four inline fields, so CP sat alone on a second row. Server
  // makes five, which pads to one whole spare slot rather than a gap.
  const statMap = new Map([
    ['tenshi', { name: 'Tenshi', classId: 'bard', itemLevel: 1770, combatScore: '≈4903.06' }],
    ['hanako', { name: 'Hanako', world: 'Thaemine' }],
  ]);
  const fields = buildEvidenceEmbed(decorateListEntry(ENTRY, 'black'), '', {
    lang: 'vi',
    statMap,
    headline: true,
    attachImage: false,
    viaName: 'Hanako',
  }).toJSON().fields;
  const inlineNames = fields.filter((f) => f.inline).map((f) => f.name);

  assert.equal(serverValue(fields), '`Thaemine`');
  assert.equal(inlineNames.filter((name) => name !== ZWSP).length, 5);
  // No "Added by" on this card · the officer who filed the entry is not
  // what the searcher is being warned about.
  assert.equal(inlineNames.some((name) => name.includes('Người thêm')), false);
});

test('the server survives the broadcast stat-record normalizer', () => {
  // Regression: the broadcast card built its map through
  // normalizeRosterStatRecord, which rebuilt each record from a fixed
  // list of five fields and silently dropped the server. The card had a
  // Server field and a resolver and still rendered nothing, because the
  // map feeding them could never carry one. Building the map by hand in
  // a test hides this · go through the real merge.
  const statMap = mergeRosterStatRecords([
    { name: 'Tenshi', classId: 'bard', itemLevel: 1770, combatScore: '≈4903.06', world: 'Thaemine' },
    { name: 'Hanako', classId: 'bard', itemLevel: 1724.33 },
  ]);

  assert.equal(statMap.get('tenshi').world, 'Thaemine');
  const fields = buildBroadcastFields({
    entry: ENTRY,
    action: 'added',
    snap: statMap.get('tenshi'),
    lang: 'vi',
    statMap,
  });
  assert.equal(serverValue(fields), '`Thaemine`');
});

test('the la-list add success card carries Server on whole rows', () => {
  // The add flow reads the roster page itself, so the server is in hand
  // by the time this card is built.
  const statMap = statMapFromRosterCharacters([
    { name: 'Tenshi', classId: 'bard', itemLevel: 1770, combatScore: '≈4903.06', world: 'Thaemine' },
  ]);
  const fields = buildListAddSuccessFields({
    payload: { type: 'black', raid: 'Kazeros Hard', reason: 'sup lo' },
    entry: ENTRY,
    entryScope: { scope: 'global' },
    icon: '⛔',
    labelCap: 'Blacklist',
    linkParts: ['[Roster](https://x.test)'],
    lang: 'vi',
    statMap,
  });
  const inlineNames = fields.filter((f) => f.inline).map((f) => f.name);

  assert.equal(serverValue(fields), '`Thaemine`');
  // List + Raid + Scope + Server is four, which Discord would split as a
  // row of three plus one stretched banner.
  assert.equal(inlineNames.filter((name) => name !== ZWSP).length, 4);
  assert.equal(inlineNames.length % 3, 0);
});

test('a non-blacklist add keeps its single inline row unpadded', () => {
  // Whitelist has no scope field, so list + raid + server is exactly one
  // row and needs no spacers.
  const statMap = statMapFromRosterCharacters([
    { name: 'Tenshi', classId: 'bard', itemLevel: 1770, world: 'Thaemine' },
  ]);
  const fields = buildListAddSuccessFields({
    payload: { type: 'white', raid: '', reason: 'ok' },
    entry: ENTRY,
    entryScope: { scope: 'server' },
    icon: '✅',
    labelCap: 'Whitelist',
    linkParts: ['[Roster](https://x.test)'],
    lang: 'vi',
    statMap,
  });
  const inlineNames = fields.filter((f) => f.inline).map((f) => f.name);

  assert.equal(inlineNames.length, 3);
  assert.equal(inlineNames.some((name) => name === ZWSP), false);
});

test('the broadcast card falls back to its own snapshot with no stat map', () => {
  // Callers that pass no statMap keep the previous behaviour rather than
  // silently losing the field.
  const fields = buildBroadcastFields({
    entry: ENTRY,
    action: 'added',
    snap: { itemLevel: 1770, combatScore: '≈4903.06', world: 'Thaemine' },
    lang: 'vi',
  });

  assert.equal(serverValue(fields), '`Thaemine`');
});
