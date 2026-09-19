import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildRemoveResultCard } = await import('../bot/handlers/list/remove/index.js');
const { statMapFromRosterCharacters } = await import('../bot/handlers/list/trackedAltsRender.js');

const ZWSP = '​';

const ENTRY = {
  name: 'Zhaohang',
  scope: 'server',
  reason: 'zdps, bỏ team giữa chừng ở gate 2 sau khi đã ăn buff',
  raid: 'Kazeros Nor',
  allCharacters: ['Zhaohang', 'Hanako', 'Mikazuki'],
};
const OK = { ok: true, entry: ENTRY, type: 'black', label: 'Blacklist', icon: '⛔' };
const STATS = statMapFromRosterCharacters([
  { name: 'Zhaohang', className: 'Paladin', itemLevel: 1740.83, combatScore: '≈3517.74', world: 'Vairgrys' },
  { name: 'Hanako', className: 'Bard', itemLevel: 1770, combatScore: '≈4089.17' },
]);

const named = (fields, needle) => fields.find((f) => f.name.includes(needle));

test('a removal records who did it and when', () => {
  // Removal cannot be undone and the old card recorded neither, so an
  // entry could vanish with no trace of who took it out.
  const fields = buildRemoveResultCard([OK], {
    name: 'Zhaohang', lang: 'vi', statMap: STATS, world: 'Vairgrys', removedBy: 'Bao',
  }).toJSON().fields;

  assert.equal(named(fields, 'Người gỡ').value, 'Bao');
  assert.match(named(fields, 'Gỡ lúc').value, /^<t:\d+:R>$/u);
  assert.equal(named(fields, 'Server').value, '`Vairgrys`');

  // Three audit badges fill exactly one row.
  assert.equal(fields.filter((f) => f.inline).length, 3);
  assert.equal(fields.some((f) => f.name === ZWSP), false);
});

test('a single removal keeps its reason whole and names the character with its class and link', () => {
  const embed = buildRemoveResultCard([OK], {
    name: 'Zhaohang', lang: 'vi', statMap: STATS, removedBy: 'Bao',
  }).toJSON();
  const reason = named(embed.fields, 'Lý do');

  // After this card the reason is gone from the database, so it is the
  // only copy left.
  assert.equal(reason.inline, false);
  assert.equal(reason.value, ENTRY.reason);
  // The title already names the list, so no separate list line repeats it.
  assert.equal(embed.fields.some((f) => f.name.includes('Đã xóa thành công')), false);
  // The emoji map is empty in tests, so the class name stands in for the icon.
  assert.match(
    embed.description,
    /Paladin \*\*\[Zhaohang\]\(https:\/\/lostark\.bible\/character\/NA\/Zhaohang\/roster\)\*\*/u
  );
  // Nothing to add after a removal, so only the timestamp stays.
  assert.equal(embed.footer, undefined);
});

test('removing from several lists keeps every reason, named by its list', () => {
  const second = {
    ok: true,
    entry: { ...ENTRY, reason: 'afk suốt gate 1' },
    type: 'watch',
    label: 'Watchlist',
    icon: '⚠️',
  };
  const fields = buildRemoveResultCard([OK, second], {
    name: 'Zhaohang', lang: 'vi', statMap: STATS, removedBy: 'Bao',
  }).toJSON().fields;

  assert.equal(
    named(fields, 'Lý do').value,
    `⛔ **Blacklist**: ${ENTRY.reason}\n⚠️ **Watchlist**: afk suốt gate 1`
  );
});

test('roster rows speak the same vocabulary as every other character list', () => {
  const fields = buildRemoveResultCard([OK], {
    name: 'Zhaohang', lang: 'vi', statMap: STATS, removedBy: 'Bao',
  }).toJSON().fields;
  const roster = named(fields, 'Danh sách roster');

  // The whole roster, removed character first, as the add card lists it.
  assert.match(roster.name, /\(3\)$/u);
  assert.match(roster.value, /^\*\*1\.\*\* Paladin \[Zhaohang\]/u);
  assert.match(roster.value, /Bard \[Hanako\]\(\S+\) · `1770\.00` · `≈4089\.17 CP`/u);
});

test('a blocked removal says so without claiming the entry was removed', () => {
  const blocked = {
    ok: false, reason: 'legacy', entry: { name: 'Zhaohang' },
    type: 'black', label: 'Blacklist', icon: '⛔',
  };
  const embed = buildRemoveResultCard([blocked], { name: 'Zhaohang', lang: 'vi' }).toJSON();

  assert.ok(named(embed.fields, 'Không thể xóa'));
  assert.equal(embed.fields.some((f) => f.name.includes('Lý do')), false);
  assert.equal(embed.description, undefined);
  assert.match(embed.footer.text, /la-list edit/u);
});

test('an entry with no reason gets a line that does not promise a copy', () => {
  const bare = { ...OK, entry: { ...ENTRY, reason: '' } };
  const embed = buildRemoveResultCard([bare], {
    name: 'Zhaohang', lang: 'vi', removedBy: 'Bao',
  }).toJSON();

  assert.equal(embed.fields.some((f) => f.name.includes('Lý do')), false);
  assert.doesNotMatch(embed.description, /chép lại lý do/u);
});
