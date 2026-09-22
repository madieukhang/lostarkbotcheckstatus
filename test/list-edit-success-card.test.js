import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildListEditSuccessEmbed, buildListEditSuccessEmbeds } = await import('../bot/handlers/list/helpers.js');
const { buildListAddSuccessFields } = await import('../bot/handlers/list/services/addExecutor.js');
const { statMapFromRosterCharacters } = await import('../bot/handlers/list/trackedAltsRender.js');
const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');
const { t } = await import('../bot/services/i18n/index.js');

const BEFORE = {
  name: 'Tenshi',
  reason: 'Left at G2',
  raid: 'Kazeros Hard',
  scope: 'server',
  allCharacters: ['Tenshi', 'Altone'],
};
const AFTER = {
  ...BEFORE,
  reason: 'Left at G2, then flamed the party',
  raid: 'Secra NM',
  allCharacters: ['Tenshi', 'Altone', 'Newalt'],
};
const STATS = statMapFromRosterCharacters([
  { name: 'Tenshi', className: 'Bard', itemLevel: '1752.5', combatScore: '2480', world: 'Thaemine' },
]);
const OPTIONS = {
  type: 'black',
  previousType: 'black',
  previousEntry: BEFORE,
  statMap: STATS,
  addedAlts: ['Newalt'],
  editorName: 'Traine',
  lang: 'vi',
};
const edit = (overrides = {}) => buildListEditSuccessEmbed(AFTER, { ...OPTIONS, ...overrides }).toJSON();
const inlineRun = (fields) => fields.slice(0, fields.findIndex((field) => field.name.startsWith('📝')));
const byPrefix = (card, prefix) => card.fields.find((field) => field.name.startsWith(prefix));

test('the edit card uses the add card title, hero and footer shape', () => {
  const card = edit();

  assert.equal(card.title, '⛔  Blacklist · Đã chỉnh sửa · Tenshi');
  assert.match(card.description, /^\*\*Traine\*\* đã sửa .*\*\*\[Tenshi\]\(https:\/\/[^)]+\)\*\* trong \*\*Blacklist\*\* `\[Nội bộ server\]`/u);
  assert.equal(card.footer.text, '🛡️ Sửa bởi Traine');
});

test('an unchanged field run matches the add card for the same entry', () => {
  const card = edit({ previousEntry: AFTER, addedAlts: [] });
  const addFields = buildListAddSuccessFields({
    payload: { type: 'black', raid: AFTER.raid, reason: AFTER.reason },
    entry: AFTER,
    entryScope: { scope: 'server' },
    icon: '⛔',
    labelCap: 'Blacklist',
    lang: 'vi',
    statMap: STATS,
  });

  assert.deepEqual(inlineRun(card.fields), inlineRun(addFields));
  assert.doesNotMatch(card.description, / · đổi /u);
});

test('a changed raid is marked in place and shown once', () => {
  const card = edit();

  assert.equal(byPrefix(card, '🗡️').name, '🗡️ Raid ✏️');
  assert.equal(byPrefix(card, '🗡️').value, '~~Kazeros Hard~~\n`Secra NM`');
  assert.equal(JSON.stringify(card).split('Secra NM').length - 1, 1);
  assert.equal(byPrefix(card, '📒').name, '📒 List');
});

test('a changed reason is struck through in its own field and nowhere else', () => {
  const card = edit();

  assert.equal(byPrefix(card, '📝').name, '📝 Lý do ✏️');
  assert.equal(byPrefix(card, '📝').value, '~~Left at G2~~\nLeft at G2, then flamed the party');
  assert.equal(card.fields.some((field) => field.name.includes('Thay đổi')), false);
});

test('the hero lists what changed and how many alts were added', () => {
  const card = edit({ logsChanged: true });
  assert.match(card.description, / · đổi \*\*Lý do\*\*, \*\*Raid\*\*, \*\*Logs\*\* · thêm \*\*1\*\* alt\.$/u);
});

test('new alts are marked in the roster list', () => {
  const roster = byPrefix(edit(), '🧬');
  const lines = roster.value.split('\n');

  assert.equal(roster.name, '🧬 Danh sách roster (3)');
  assert.match(lines[2], /\[Newalt\]\([^)]+\) 🆕$/u);
  assert.doesNotMatch(lines.slice(0, 2).join('\n'), /🆕/u);
});

test('a move strikes the old list and uses the moved title', () => {
  const card = edit({
    isMove: true,
    previousType: 'watch',
    previousEntry: { ...AFTER, scope: undefined },
    addedAlts: [],
  });

  assert.equal(card.title, '⛔  Blacklist · Đã sửa và chuyển list · Tenshi');
  assert.equal(byPrefix(card, '📒').name, '📒 List ✏️');
  assert.equal(byPrefix(card, '📒').value, '~~⚠️ Watchlist~~\n⛔ Blacklist');
  assert.equal(byPrefix(card, '🌐').name, '🌐 Scope');
});

test('a scope change on a blacklist entry is marked on the scope field', () => {
  const card = edit({ previousEntry: { ...AFTER, scope: 'global' }, addedAlts: [] });

  assert.equal(byPrefix(card, '🌐').name, '🌐 Scope ✏️');
  assert.equal(byPrefix(card, '🌐').value, '~~Toàn cục~~\nNội bộ server');
});

test('the hero keeps the class icon and roster link', (t) => {
  const previous = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = '<:bard:123456789012345678>';
  t.after(() => { CLASS_EMOJI_MAP.Bard = previous; });

  assert.match(edit().description, /<:bard:123456789012345678> \*\*\[Tenshi\]\(https:\/\//u);
});

test('unchanged evidence carries the add card download line', () => {
  const url = 'https://example.test/current.png';
  const card = edit({ freshDisplayUrl: url });

  assert.equal(card.fields.at(-1).name, t('listView.evidence.attached', 'vi'));
  assert.equal(card.fields.at(-1).value, t('dialogue.listAdd.success.evidence', 'vi', { url }));
  assert.equal(card.image.url, url);
});

for (const lang of ['vi', 'en', 'jp']) {
  test(`replaced evidence shows before and after images with a download link (${lang})`, () => {
    const cards = buildListEditSuccessEmbeds(AFTER, {
      ...OPTIONS,
      evidenceChanged: true,
      hadPreviousEvidence: true,
      previousDisplayUrl: 'https://example.test/before.png',
      freshDisplayUrl: 'https://example.test/after.png',
      lang,
    }).map((embed) => embed.toJSON());

    assert.equal(cards.length, 2);
    assert.equal(cards[0].image.url, 'https://example.test/before.png');
    assert.equal(cards[1].image.url, 'https://example.test/after.png');
    assert.equal(cards[0].fields.at(-1).name, t('listView.evidence.attached', lang));
    assert.equal(cards[0].fields.at(-1).value, `**${t('dialogue.listEdit.evidence.before', lang)}**`);
    assert.equal(cards[1].title, t('dialogue.listEdit.evidence.after', lang));
    assert.equal(cards[1].description, t('dialogue.listEdit.evidence.download', lang, { url: 'https://example.test/after.png' }));
    assert.equal(cards[1].color, cards[0].color);
    assert.match(cards[0].description, new RegExp(`\\*\\*${t('dialogue.listEdit.success.summaryFields.evidence', lang)}\\*\\*`, 'u'));
    assert.equal(cards[0].footer.text, `🛡️ ${t('dialogue.listEdit.success.footer', lang, { user: 'Traine' })}`);
    assert.equal(cards[1].footer, undefined);
    assert.doesNotMatch(JSON.stringify(cards), /dialogue\.|listView\.|undefined/u);
  });
}

test('adding the first image distinguishes absent evidence from an unavailable archived image', () => {
  for (const hadPreviousEvidence of [false, true]) {
    const cards = buildListEditSuccessEmbeds(AFTER, {
      ...OPTIONS,
      type: 'watch',
      previousType: 'watch',
      evidenceChanged: true,
      hadPreviousEvidence,
      freshDisplayUrl: 'https://example.test/first.png',
    }).map((embed) => embed.toJSON());

    assert.equal(cards[0].image, undefined);
    assert.equal(cards[0].fields.at(-1).value,
      `**Trước khi đổi:** ${hadPreviousEvidence ? 'Không tải được ảnh' : 'Chưa có ảnh'}`);
    assert.equal(cards[1].title, 'Sau khi đổi');
    assert.equal(cards[1].image.url, 'https://example.test/first.png');
  }
});

test('unavailable new evidence keeps the old preview under the before label', () => {
  const cards = buildListEditSuccessEmbeds(AFTER, {
    ...OPTIONS,
    type: 'white',
    previousType: 'white',
    evidenceChanged: true,
    previousDisplayUrl: 'https://example.test/before.png',
  }).map((embed) => embed.toJSON());

  assert.equal(cards[0].image.url, 'https://example.test/before.png');
  assert.equal(cards[1].title, 'Sau khi đổi');
  assert.equal(cards[1].description, 'Không tải được ảnh');
  assert.equal(cards[1].image, undefined);
});

test('an edit without image replacement shows the current image once and no comparison labels', () => {
  for (const freshDisplayUrl of ['', 'https://example.test/current.png']) {
    const cards = buildListEditSuccessEmbeds(AFTER, { ...OPTIONS, freshDisplayUrl })
      .map((embed) => embed.toJSON());

    assert.equal(cards.length, 1);
    assert.equal(cards[0].image?.url || '', freshDisplayUrl);
    assert.equal(cards[0].fields.filter((field) => field.name === '📎 Evidence').length, freshDisplayUrl ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(cards), /Trước khi đổi|Sau khi đổi/u);
  }
});
