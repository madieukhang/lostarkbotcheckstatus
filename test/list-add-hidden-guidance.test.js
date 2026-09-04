import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  buildDuplicateListAddResult,
  buildHiddenRosterGuidance,
  buildListAddSuccessHeader,
  buildListAddTrackedRostersField,
} = await import('../bot/handlers/list/services/addExecutor.js');
const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');

const ZWSP = '​';

test('hidden roster add guidance offers enrich when bible exposes a guild', () => {
  const guidance = buildHiddenRosterGuidance('Ainslinn', 'Bullet Shell');

  assert.equal(guidance.fields.length, 1);
  assert.match(guidance.fields[0].value, /Bible shows guild \*\*Bullet Shell\*\*/);
  assert.match(guidance.fields[0].value, /\/la-list enrich name:Ainslinn/);
  assert.equal(guidance.components.length, 1);
});

test('hidden roster add guidance avoids enrich button without a guild', () => {
  const guidance = buildHiddenRosterGuidance('Ainslinn', '');

  assert.equal(guidance.fields.length, 1);
  assert.match(guidance.fields[0].value, /needs a visible guild member list/);
  assert.match(guidance.fields[0].value, /\/la-list edit name:Ainslinn additional_names:Alt1, Alt2/);
  assert.equal(guidance.components.length, 0);
});

test('duplicate roster result opens with the reason pair and fills a whole six-cell grid', () => {
  const existed = {
    name: 'Lungzhu',
    scope: 'global',
    addedByDisplayName: 'Bao',
    addedAt: new Date('2026-05-17T10:30:00Z'),
    reason: 'zdps',
    raid: 'Kazeros Nor',
    allCharacters: ['Lungzhu', 'Zhaohang'],
  };
  const oldPaladinEmoji = CLASS_EMOJI_MAP.Paladin;
  const oldBardEmoji = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Paladin = '<:paladin:42>';
  CLASS_EMOJI_MAP.Bard = '<:bard:43>';

  try {
    const result = buildDuplicateListAddResult({
      existed,
      name: 'Zhaohang',
      labelCap: 'Blacklist',
      type: 'black',
      lang: 'en',
      statMap: new Map([
        ['zhaohang', { name: 'Zhaohang', className: 'Paladin', world: 'Vairgrys' }],
        ['lungzhu', { name: 'Lungzhu', className: 'Bard', world: 'Vairgrys' }],
      ]),
      typedReason: 'ninja loot g2',
    });
    const embed = result.embeds[0].toJSON();
    const fields = embed.fields;

    // Both identities carry a class icon and a Bible link, bolded the way
    // the /la-check headline this sentence is modelled on does it.
    assert.match(
      embed.description,
      /<:paladin:42> \*\*\[Zhaohang\]\(https:\/\/lostark\.bible\/character\/NA\/Zhaohang\/roster\)\*\*/u,
    );
    assert.match(
      embed.description,
      /<:bard:43> \*\*\[Lungzhu\]\(https:\/\/lostark\.bible\/character\/NA\/Lungzhu\/roster\)\*\*/u,
    );
    assert.match(embed.description, /shares a roster with/u);
    // The sentence has to say the add did not happen, or the officer is
    // left unsure whether their entry was recorded.
    assert.match(embed.description, /Nothing new was saved/u);

    // Reason pair opens the card: stored above, typed directly under it.
    assert.deepEqual(fields.slice(0, 2).map((f) => [f.name, f.value, f.inline]), [
      ['📝 Stored reason', 'zdps', false],
      ['✏️ Reason you just typed', 'ninja loot g2', false],
    ]);

    const grid = fields.slice(2);
    assert.equal(grid.every((field) => field.inline), true);
    assert.deepEqual(grid.map((field) => field.name), [
      '🧬 Matched name',
      '🌍 Server',
      '🌐 Scope',
      '🗡️ Raid',
      '👤 Added by',
      '🕐 Time added',
    ]);
    // Six fills two rows exactly, so nothing needs a spacer.
    assert.equal(grid.some((field) => field.name === ZWSP), false);
    assert.equal(
      grid[0].value,
      '<:bard:43> **[Lungzhu](https://lostark.bible/character/NA/Lungzhu/roster)**',
    );
    assert.equal(grid[1].value, '`Vairgrys`');
    assert.equal(grid[3].value, '`Kazeros Nor`');

    // Match type is gone · the sentence above already says how it matched.
    assert.equal(fields.some((field) => field.name.includes('Match type')), false);
  } finally {
    CLASS_EMOJI_MAP.Paladin = oldPaladinEmoji;
    CLASS_EMOJI_MAP.Bard = oldBardEmoji;
  }
});

test('duplicate card drops the typed-reason block when the add carried none', () => {
  const result = buildDuplicateListAddResult({
    existed: { name: 'Lungzhu', reason: 'zdps', addedByDisplayName: 'Bao' },
    name: 'Lungzhu',
    labelCap: 'Blacklist',
    type: 'black',
    lang: 'en',
  });
  const fields = result.embeds[0].toJSON().fields;

  assert.deepEqual(fields.filter((f) => !f.inline).map((f) => f.name), ['📝 Stored reason']);
  // Direct name match with no scope, raid or server leaves two inline
  // fields, and two split one row evenly, so they stay unpadded.
  assert.deepEqual(fields.filter((f) => f.inline).map((f) => f.name), [
    '👤 Added by',
    '🕐 Time added',
  ]);
  assert.equal(fields.some((f) => f.name === ZWSP), false);
});

test('duplicate card tolerates an entry with no stored metadata at all', () => {
  const result = buildDuplicateListAddResult({
    existed: { name: 'Lungzhu' },
    name: 'Lungzhu',
    labelCap: 'Blacklist',
    type: 'black',
    lang: 'vi',
  });
  const fields = result.embeds[0].toJSON().fields;

  // Legacy rows written before these columns existed must fall back
  // rather than render an empty value Discord would reject.
  assert.equal(fields[0].name, '📝 Lý do đang lưu');
  assert.equal(fields[0].value, 'Chưa có');
  assert.equal(fields[1].value, 'Chưa có');
  assert.equal(fields[2].value, 'Chưa có');
});

test('list-add success keeps one list icon and links the primary name with its class icon', () => {
  const oldPaladinEmoji = CLASS_EMOJI_MAP.Paladin;
  CLASS_EMOJI_MAP.Paladin = '<:paladin:42>';

  try {
    const header = buildListAddSuccessHeader({
      icon: '⛔',
      requesterName: 'meow',
      entryName: 'Beatadin',
      listLabel: 'Blacklist',
      scopeTag: ' `[Global]`',
      primaryRecord: { className: 'Paladin' },
      lang: 'en',
    });

    assert.equal(header.titleIcon, '⛔');
    assert.equal(
      header.heroLine,
      '**meow** added <:paladin:42> **[Beatadin](https://lostark.bible/character/NA/Beatadin/roster)** to **Blacklist** `[Global]`.'
    );
  } finally {
    CLASS_EMOJI_MAP.Paladin = oldPaladinEmoji;
  }
});

test('list-add success labels and counts the primary character plus its tracked roster', () => {
  const field = buildListAddTrackedRostersField({
    names: ['Hanako', 'HANAKO'],
    primaryName: 'Tenshi',
    lang: 'en',
  });

  assert.equal(field.name, '🧬 Tracked rosters (2)');
  assert.match(field.value, /^\*\*1\.\*\* \[Tenshi\]/);
  assert.match(field.value, /\n\*\*2\.\*\* \[Hanako\]/);
});
