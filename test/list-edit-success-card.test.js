import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildListEditSuccessEmbed } = await import('../bot/handlers/list/helpers.js');
const { t } = await import('../bot/services/i18n/index.js');

const ZWSP = '​';
const ENTRY = {
  name: 'Tenshi',
  reason: 'Griefing the final gate for two weeks running',
  raid: 'Kazeros Hard',
};
const changeLines = (lang) => [
  t('dialogue.listEdit.change.raid', lang, { old: 'N/A', next: 'Kazeros Hard' }),
  t('dialogue.listEdit.change.evidence', lang),
];

test('edit success card gives reason the full width and icon-labels its fields', () => {
  const embed = buildListEditSuccessEmbed(ENTRY, {
    changes: changeLines('vi'), type: 'black', requesterDisplayName: 'meow', lang: 'vi',
  }).toJSON();
  const byName = (needle) => embed.fields.find((f) => f.name.includes(needle));

  // Reason is prose · inline it was squeezed into a third of the card.
  assert.equal(byName('Lý do').inline, false);
  assert.equal(byName('Tên').inline, true);
  assert.equal(byName('Raid').inline, true);
  assert.equal(byName('Raid').value, '`Kazeros Hard`');

  // Every label carries an icon, like the other cards in this family.
  for (const needle of ['Tên', 'Raid', 'Lý do', 'Thay đổi']) {
    assert.match(byName(needle).name, /^\p{Extended_Pictographic}/u, needle);
  }

  // Name + Raid share one row and split it evenly. Padding them to
  // thirds would shrink both and leave a gap, so no spacer is added.
  assert.equal(embed.fields.filter((f) => f.inline).length, 2);
  assert.equal(embed.fields.some((f) => f.name === ZWSP), false);
});

test('a lone inline field is not padded into a third of a row', () => {
  // Only Name renders when the entry has no raid; one inline field fills
  // the row on its own, so spacers would just add two empty columns.
  const embed = buildListEditSuccessEmbed({ ...ENTRY, raid: '' }, {
    changes: changeLines('vi'), type: 'black', lang: 'vi',
  }).toJSON();

  assert.equal(embed.fields.filter((f) => f.inline).length, 1);
  assert.equal(embed.fields.some((f) => f.name === ZWSP), false);
});

test('change lines carry their own icon and code-wrapped values', () => {
  const embed = buildListEditSuccessEmbed(ENTRY, {
    changes: changeLines('vi'), type: 'black', lang: 'vi',
  }).toJSON();
  const changes = embed.fields.find((f) => f.name.includes('Thay đổi'));

  // Values read as values, and the bullet is gone · each line already
  // opens with an icon of its own.
  assert.match(changes.value, /🗡️ \*\*Raid:\*\* `N\/A` → `Kazeros Hard`/u);
  assert.doesNotMatch(changes.value, /^•/mu);
  assert.match(changes.name, /\(2\)/u);
});
