import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildAutoCheckEvidenceRow,
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
  assert.equal(select.options.length, 1);
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
  assert.equal(select.options.length, 1);
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
