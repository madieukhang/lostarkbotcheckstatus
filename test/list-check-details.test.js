import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildAutoCheckEvidenceRow } = await import('../bot/handlers/list/check/index.js');
const { buildEvidenceEmbed } = await import('../bot/handlers/list/view/ui.js');

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

test('list-entry detail still renders raid and added-by metadata without an image', () => {
  const embed = buildEvidenceEmbed({
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
  }, null, { includeAddedBy: true, lang: 'vi' }).toJSON();

  const fields = new Map(embed.fields.map((field) => [field.name, field.value]));
  assert.equal(fields.get('🗡️ Raid'), '`Kazeros Hard`');
  assert.equal(fields.get('👤 Người thêm'), 'Legacy Officer');
  assert.equal(fields.get('⚠️ Evidence'), 'Entry này chưa có ảnh evidence.');
});
