import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildAutoCheckEvidenceRow,
  createCheckHandlers,
  loadCheckDetailStatMap,
} = await import('../bot/handlers/list/check/index.js');
const { buildCheckEntryDetailsEmbed } = await import('../bot/handlers/list/check/ui.js');

test('check details dropdown includes a blacklist entry without an evidence image', () => {
  const blackId = 'a'.repeat(24);
  const watchId = 'b'.repeat(24);
  const row = buildAutoCheckEvidenceRow([{
    name: 'Checkedalt',
    blackEntry: {
      _id: blackId,
      name: 'Rosterprimary',
      reason: 'Blacklist report',
      raid: 'Kazeros Hard',
    },
    watchEntry: {
      _id: watchId,
      name: 'Watchprimary',
      reason: 'Watch report',
      imageUrl: 'https://cdn.example.test/watch.png',
    },
  }], 'vi');

  const select = row.toJSON().components[0];
  assert.match(select.placeholder, /Xem chi tiết/u);
  assert.equal(select.options.length, 2);
  assert.equal(select.options[0].label, 'Checkedalt');
  assert.equal(select.options[0].value, `black:${blackId}`);
});

test('check details dropdown de-duplicates multiple checked alts from one entry', () => {
  const blackId = 'c'.repeat(24);
  const sharedEntry = {
    _id: blackId,
    name: 'Rosterprimary',
    reason: 'Same roster report',
  };
  const row = buildAutoCheckEvidenceRow([
    { name: 'Altone', blackEntry: sharedEntry },
    { name: 'Alttwo', blackEntry: sharedEntry },
  ], 'en');

  const select = row.toJSON().components[0];
  assert.equal(select.options.length, 2);
  assert.equal(select.options[0].value, `black:${blackId}`);
});

test('check details dropdown keeps the screenshot name visible after canonical correction', () => {
  const blackId = 'd'.repeat(24);
  const row = buildAutoCheckEvidenceRow([{
    inputName: 'Altchxr',
    name: 'Altchar',
    blackEntry: {
      _id: blackId,
      name: 'Altchar',
      reason: 'Confirmed report',
    },
  }], 'en');

  const select = row.toJSON().components[0];
  assert.equal(select.options[0].label, 'Altchxr → Altchar');
});

test('check details reserves a reset option within the Discord 25-option limit', () => {
  const results = Array.from({ length: 30 }, (_, i) => ({
    name: `Character${i}`,
    blackEntry: { _id: String(i).padStart(24, '0'), reason: 'Report' },
  }));
  for (const lang of ['en', 'vi', 'jp']) {
    const select = buildAutoCheckEvidenceRow(results, lang).toJSON().components[0];
    assert.equal(select.options.length, 25);
    assert.equal(select.options.at(-1).value, 'none');
    assert.ok(!select.options.at(-1).label.includes('listView.'));
  }
  assert.equal(buildAutoCheckEvidenceRow([]), null);
});

test('Select none resets only the details menu without a DB read or extra reply', async () => {
  const row = buildAutoCheckEvidenceRow([{
    name: 'Character', blackEntry: { _id: 'a'.repeat(24), reason: 'Report' },
  }]).toJSON();
  row.components[0].options[0].default = true;
  const otherRow = { type: 1, components: [{ type: 2, style: 2, custom_id: 'keep', label: 'Keep' }] };
  let updated;
  const handler = createCheckHandlers({ client: {} }).handleAutoCheckEvidenceSelect;
  await handler({
    values: ['none'],
    message: { components: [row, otherRow] },
    update: async payload => { updated = payload; },
    deferReply: () => assert.fail('Reset must acknowledge the original menu only'),
  });
  assert.deepEqual(Object.keys(updated), ['components']);
  const rows = updated.components.map(value => value.toJSON?.() || value);
  assert.ok(rows[0].components[0].options.every(option => !option.default));
  assert.deepEqual(rows[1], otherRow);
});

test('check detail snapshot loader stays DB-only and includes primary plus tracked alts', async () => {
  let receivedQuery;
  let receivedCollation;
  const RosterSnapshotModel = {
    find(query) {
      receivedQuery = query;
      return {
        collation(value) {
          receivedCollation = value;
          return this;
        },
        async lean() {
          return [
            { name: 'Rosterprimary', classId: 'bard', itemLevel: 1725.5, combatScore: '≈3136.08' },
            { name: 'Checkedalt', classId: 'blade', itemLevel: 1711.67, combatScore: '≈2981.11' },
          ];
        },
      };
    },
  };

  const statMap = await loadCheckDetailStatMap({
    name: 'Rosterprimary',
    allCharacters: ['Rosterprimary', 'Checkedalt', 'Checkedalt'],
  }, { RosterSnapshotModel });

  assert.deepEqual(receivedQuery, {
    name: { $in: ['Rosterprimary', 'Checkedalt'] },
  });
  assert.deepEqual(receivedCollation, { locale: 'en', strength: 2 });
  assert.equal(statMap.get('rosterprimary').combatScore, '≈3136.08');
  assert.equal(statMap.get('checkedalt').itemLevel, 1711.67);
});

test('dropdown detail uses broadcast layout with added-by beside CP and evidence below', () => {
  const statMap = new Map([
    ['rosterprimary', {
      name: 'Rosterprimary',
      className: 'Bard',
      itemLevel: 1725.5,
      combatScore: '≈3136.08',
    }],
    ['checkedalt', {
      name: 'Checkedalt',
      className: 'Blade',
      itemLevel: 1711.67,
      combatScore: '≈2981.11',
    }],
  ]);
  const embed = buildCheckEntryDetailsEmbed({
    name: 'Rosterprimary',
    reason: 'Blacklist report',
    raid: 'Kazeros Hard',
    addedAt: new Date('2026-07-31T00:00:00Z'),
    addedByName: 'Legacy Officer',
    allCharacters: ['Rosterprimary', 'Checkedalt'],
    _listType: 'black',
    _label: 'blacklist',
    _icon: '⛔',
    _color: 0xed4245,
  }, {
    displayUrl: 'https://cdn.example.test/evidence.png',
    includeAddedBy: true,
    lang: 'vi',
    statMap,
  }).toJSON();

  assert.equal(embed.title, '🔎 Kết quả kiểm tra · Blacklist');
  assert.match(embed.description, /Rosterprimary/u);
  assert.match(embed.description, /hiện nằm trong \*\*Blacklist\*\*/u);
  assert.doesNotMatch(embed.description, /vừa được thêm/u);
  // Two full inline rows: Raid / Added / ilvl, then CP / Added by /
  // Server. Without Server the second row held two fields and Discord
  // stretched them across the card.
  assert.deepEqual(embed.fields.map((field) => field.name), [
    '📝 Lý do',
    '🗡️ Raid',
    '🕐 Đã thêm',
    '📊 ilvl',
    '⚔️ CP',
    '👤 Người thêm',
    '🌍 Server',
    '🧬 Danh sách roster (2)',
    // The embedded screenshot gets a heading of its own so it does not
    // run straight on from the roster list.
    '📎 Evidence',
  ]);
  assert.equal(embed.fields.filter((field) => field.inline).length % 3, 0);
  // ilvl and CP sit side by side, so both read as code values.
  assert.equal(embed.fields[3].value, '`1725.50`');
  assert.equal(embed.fields[4].value, '`≈3136.08`');
  assert.equal(embed.fields[4].inline, true);
  assert.equal(embed.fields[5].value, 'Legacy Officer');
  assert.equal(embed.fields[5].inline, true);
  // The roster list counts the entry itself now, not just its alts.
  assert.match(embed.fields[7].value, /`1711\.67` · `≈2981\.11 CP`/u);
  assert.match(embed.fields[7].value, /Rosterprimary/u);
  assert.equal(embed.image.url, 'https://cdn.example.test/evidence.png');
});
