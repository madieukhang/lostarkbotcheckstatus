import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildListEntryInlineFields,
  buildListEntryReasonField,
  formatStruckValue,
} = await import('../bot/handlers/list/entryCardFields.js');
const { statMapFromRosterCharacters } = await import('../bot/handlers/list/trackedAltsRender.js');

const ENTRY = { name: 'Tenshi', allCharacters: ['Tenshi', 'Altone'] };
const STATS = statMapFromRosterCharacters([
  { name: 'Tenshi', className: 'Bard', itemLevel: '1752.5', combatScore: '2480', world: 'Thaemine' },
]);
const BASE = {
  type: 'black',
  raid: 'Secra NM',
  scope: 'server',
  entry: ENTRY,
  statMap: STATS,
  icon: '⛔',
  labelCap: 'Blacklist',
  lang: 'vi',
};

test('an unchanged entry renders the add card run with no change marks', () => {
  const fields = buildListEntryInlineFields(BASE);

  assert.deepEqual(fields.map((field) => field.name), ['📒 List', '🗡️ Raid', '🌐 Scope', '🌍 Server', '📊 ilvl', '⚔️ CP']);
  assert.ok(fields.every((field) => !field.name.includes('✏️') && !field.value.includes('~~')));
});

test('changed list, raid and scope carry the mark and the struck old value', () => {
  const fields = buildListEntryInlineFields({
    ...BASE,
    previous: { list: { icon: '⚠️', labelCap: 'Watchlist' }, raid: 'Kazeros Hard', scope: 'global' },
  });
  const byPrefix = (prefix) => fields.find((field) => field.name.startsWith(prefix));

  assert.equal(byPrefix('📒').name, '📒 List ✏️');
  assert.equal(byPrefix('📒').value, '~~⚠️ Watchlist~~\n⛔ Blacklist');
  assert.equal(byPrefix('🗡️').value, '~~Kazeros Hard~~\n`Secra NM`');
  assert.equal(byPrefix('🌐').value, '~~Toàn cục~~\nNội bộ server');
  assert.equal(byPrefix('🌍').name, '🌍 Server');
});

test('a raid added to an entry without one strikes the empty placeholder', () => {
  const fields = buildListEntryInlineFields({ ...BASE, previous: { raid: '' } });
  assert.equal(fields[1].value, '~~Chưa có~~\n`Secra NM`');
});

test('the struck value is one line with tildes and backslashes escaped', () => {
  assert.equal(formatStruckValue('Old\nreason ~ here'), '~~Old reason \\~ here~~');
  assert.equal(formatStruckValue('ends with \\'), '~~ends with \\\\~~');
});

test('a cut struck value never leaves an odd backslash run before the closing marker', () => {
  for (const source of ['~'.repeat(500), '\\'.repeat(500)]) {
    for (let cap = 20; cap < 200; cap += 1) {
      const struck = formatStruckValue(source, cap);
      const inner = struck.slice(2, -2).replace(/…$/u, '');
      assert.ok(struck.length <= cap, `cap ${cap}`);
      assert.equal(inner.match(/\\*$/u)[0].length % 2, 0, `cap ${cap}`);
    }
  }
});

test('the reason field strikes the old reason above the new one', () => {
  const field = buildListEntryReasonField({ reason: 'New reason', previousReason: 'Old reason', lang: 'vi' });
  assert.deepEqual(field, { name: '📝 Lý do ✏️', value: '~~Old reason~~\nNew reason', inline: false });
});

test('a long old reason is cut so the field stays within 1024 characters', () => {
  const field = buildListEntryReasonField({ reason: 'n'.repeat(900), previousReason: 'o'.repeat(900), lang: 'vi' });
  assert.ok(field.value.length <= 1024);
  assert.match(field.value, /^~~o+…~~\nn{900}$/u);
});

test('the struck reason is dropped when the new reason leaves no room', () => {
  const field = buildListEntryReasonField({ reason: 'n'.repeat(1015), previousReason: 'old', lang: 'vi' });
  assert.equal(field.name, '📝 Lý do ✏️');
  assert.equal(field.value, 'n'.repeat(1015));
});

test('an unchanged reason renders exactly like the add card', () => {
  assert.deepEqual(
    buildListEntryReasonField({ reason: 'Same', lang: 'vi' }),
    { name: '📝 Lý do', value: 'Same', inline: false },
  );
});
