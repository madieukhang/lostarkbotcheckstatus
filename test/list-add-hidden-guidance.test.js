import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const {
  appendDuplicateAuditRow,
  buildDuplicateAuditFields,
  buildDuplicateListAddResult,
  buildHiddenRosterGuidance,
  buildListAddSuccessHeader,
  buildListAddTrackedRostersField,
} = await import('../bot/handlers/list/services/addExecutor.js');
const { CLASS_EMOJI_MAP } = await import('../bot/models/Class.js');

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

test('duplicate roster card fills the audit row third slot with Server', () => {
  const addedAt = new Date('2026-05-17T10:30:00Z');
  const fields = buildDuplicateAuditFields({
    addedByDisplayName: 'meow',
    addedAt,
  }, 'en', { world: 'Vairgrys' });

  assert.deepEqual(fields, [
    { name: '👤 Added by', value: 'meow', inline: true },
    {
      name: '🕐 Time added',
      value: `<t:${Math.floor(addedAt.getTime() / 1000)}:R>`,
      inline: true,
    },
    { name: '🌍 Server', value: '`Vairgrys`', inline: true },
  ]);
});

test('duplicate roster result uses the freshly loaded roster Server in its full six-cell grid', () => {
  const existed = {
    name: 'Lungzhu',
    scope: 'global',
    addedByDisplayName: 'Bao',
    addedAt: new Date('2026-05-17T10:30:00Z'),
    reason: 'zdps',
    raid: 'Kazeros Nor',
    allCharacters: ['Lungzhu', 'Zhaohang'],
  };
  const result = buildDuplicateListAddResult({
    existed,
    name: 'Zhaohang',
    labelCap: 'Blacklist',
    type: 'black',
    lang: 'en',
    statMap: new Map([
      ['zhaohang', { name: 'Zhaohang', world: 'Vairgrys' }],
    ]),
  });
  const fields = result.embeds[0].toJSON().fields;
  const metadataGrid = fields.slice(0, 6);

  assert.equal(metadataGrid.every((field) => field.inline), true);
  assert.deepEqual(metadataGrid.map((field) => field.name), [
    '🔍 Match type',
    '🧬 Matched name',
    '🌐 Scope',
    '👤 Added by',
    '🕐 Time added',
    '🌍 Server',
  ]);
  assert.equal(metadataGrid[5].value, '`Vairgrys`');
  assert.equal(fields[6].inline, false, 'reason starts the detail section after the grid');
  assert.equal(fields[7].name, '🗡️ Raid');
});

test('duplicate audit row starts after match metadata and keeps Time added in column two', () => {
  const fields = [
    { name: 'Match type', value: 'Exact name', inline: true },
    { name: 'Scope', value: '[Global]', inline: true },
  ];

  appendDuplicateAuditRow(fields, {
    addedByDisplayName: 'meow',
    addedAt: new Date('2026-05-17T10:30:00Z'),
  }, 'en');

  assert.equal(fields.length, 6);
  assert.equal(fields[2].name, '\u200b', 'metadata row is padded to three columns');
  assert.equal(fields[3].name, '👤 Added by');
  assert.equal(fields[4].name, '🕐 Time added');
  assert.equal(fields[5].name, '\u200b', 'audit row keeps a fixed third column');
});

test('duplicate audit fields tolerate missing legacy metadata', () => {
  const fields = buildDuplicateAuditFields({}, 'vi');

  assert.deepEqual(fields, [
    { name: '👤 Được thêm bởi', value: 'Chưa có', inline: true },
    { name: '🕐 Thời gian thêm', value: 'Chưa có', inline: true },
    { name: '\u200b', value: '\u200b', inline: true },
  ]);
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
