import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildListEditSuccessEmbed, buildListEditSuccessEmbeds } = await import('../bot/handlers/list/helpers.js');
const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');
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
  assert.equal(embed.footer, undefined);
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
  assert.match(changes.name, /\(1\)/u);
  assert.doesNotMatch(changes.value, /Evidence/u);
});

test('edit success name uses the class emoji and retains the roster link', t => {
  const previous = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = '<:bard:123456789012345678>';
  t.after(() => { CLASS_EMOJI_MAP.Bard = previous; });
  const card = buildListEditSuccessEmbed(ENTRY, {
    type: 'black', primaryRecord: { classId: 'bard' }, lang: 'vi',
  }).toJSON();
  assert.match(card.fields[0].value, /^<:bard:123456789012345678> \[Tenshi\]\(https:\/\//);

  const withoutSnapshot = buildListEditSuccessEmbed(ENTRY, { type: 'black' }).toJSON();
  assert.match(withoutSnapshot.fields[0].value, /^\[Tenshi\]\(https:\/\//);
});

for (const lang of ['vi', 'en', 'jp']) {
  test(`replaced evidence shows labeled before and after images without duplicate Evidence (${lang})`, () => {
    const cards = buildListEditSuccessEmbeds(ENTRY, {
      changes: changeLines(lang), type: 'black', evidenceChanged: true,
      previousDisplayUrl: 'https://example.test/before.png',
      freshDisplayUrl: 'https://example.test/after.png',
      hadPreviousEvidence: true, requesterDisplayName: 'Editor', lang,
    }).map(embed => embed.toJSON());

    assert.equal(cards.length, 2);
    assert.equal(cards[0].image.url, 'https://example.test/before.png');
    assert.equal(cards[1].image.url, 'https://example.test/after.png');
    assert.equal(cards[0].fields.at(-1).name, t('listView.evidence.attached', lang));
    assert.equal(cards[0].fields.at(-1).value, `**${t('dialogue.listEdit.evidence.before', lang)}**`);
    assert.equal(cards[1].title, t('dialogue.listEdit.evidence.after', lang));
    assert.equal(cards[1].color, cards[0].color);
    const fields = cards.flatMap(card => card.fields || []);
    assert.equal(fields.filter(field => field.name === t('listView.evidence.attached', lang)).length, 1);
    assert.ok(fields.every(field => !field.value.includes(t('dialogue.listEdit.change.evidence', lang))));
    assert.ok(cards.every(card => card.footer === undefined));
    assert.doesNotMatch(JSON.stringify(cards), /Editor|dialogue\.|listView\./);
  });
}

test('adding the first image distinguishes absent evidence from an unavailable archived image', () => {
  for (const hadPreviousEvidence of [false, true]) {
    const cards = buildListEditSuccessEmbeds(ENTRY, {
      changes: [t('dialogue.listEdit.change.evidence', 'vi')],
      type: 'watch', evidenceChanged: true, hadPreviousEvidence,
      freshDisplayUrl: 'https://example.test/first.png', lang: 'vi',
    }).map(embed => embed.toJSON());
    assert.equal(cards[0].image, undefined);
    assert.equal(cards[0].fields.at(-1).value,
      `**Trước khi đổi:** ${hadPreviousEvidence ? 'Không tải được ảnh' : 'Chưa có ảnh'}`);
    assert.equal(cards[0].fields.some(field => field.name.includes('Thay đổi')), false);
    assert.equal(cards[1].title, 'Sau khi đổi');
    assert.equal(cards[1].image.url, 'https://example.test/first.png');
  }
});

test('unavailable new evidence keeps the old preview under the before label', () => {
  const cards = buildListEditSuccessEmbeds(ENTRY, {
    type: 'white', evidenceChanged: true,
    previousDisplayUrl: 'https://example.test/before.png', lang: 'vi',
  }).map(embed => embed.toJSON());
  assert.equal(cards[0].image.url, 'https://example.test/before.png');
  assert.equal(cards[1].title, 'Sau khi đổi');
  assert.equal(cards[1].description, 'Không tải được ảnh');
  assert.equal(cards[1].image, undefined);
});

test('an edit without image replacement shows the current image once and has no comparison labels', () => {
  for (const freshDisplayUrl of ['', 'https://example.test/current.png']) {
    const cards = buildListEditSuccessEmbeds(ENTRY, {
      changes: ['Raid changed'], type: 'black', freshDisplayUrl, lang: 'vi',
    }).map(embed => embed.toJSON());
    assert.equal(cards.length, 1);
    assert.equal(cards[0].image?.url || '', freshDisplayUrl);
    assert.equal(cards[0].fields.filter(field => field.name === '📎 Evidence').length, freshDisplayUrl ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(cards), /Trước khi đổi|Sau khi đổi/);
  }
});
