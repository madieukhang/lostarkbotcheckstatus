import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN ||= 'test';
process.env.CHANNEL_ID ||= 'test';
process.env.MONGODB_URI ||= 'mongodb://localhost:27017/test';

const { buildEvidenceEmbed } = await import('../bot/handlers/list/view/ui.js');
const { decorateListEntry } = await import('../bot/handlers/list/helpers.js');
const { statMapFromRosterCharacters } = await import('../bot/handlers/list/trackedAltsRender.js');

const ZWSP = '​';

function makeEntry(overrides = {}) {
  return decorateListEntry({
    name: 'Tenshi',
    reason: 'Griefing report',
    raid: 'Kazeros Hard',
    addedAt: new Date('2026-08-30T09:00:00Z'),
    addedByDisplayName: 'Officer',
    allCharacters: ['Tenshi', 'Hanako', 'Mikazuki'],
    ...overrides,
  }, 'black');
}

const ROSTER = [
  { name: 'Tenshi', className: 'Souleater', itemLevel: '1755.00', combatScore: '≈4820.12' },
  { name: 'Hanako', className: 'Bard', itemLevel: '1730.83', combatScore: '≈3311.40' },
  { name: 'Mikazuki', className: 'Reaper', itemLevel: '1720.00', combatScore: '≈2984.55' },
];

const inlineNames = (embed) => embed.toJSON().fields.filter((f) => f.inline).map((f) => f.name);
const fieldValue = (embed, needle) =>
  embed.toJSON().fields.find((f) => f.name.includes(needle))?.value;

test('evidence card renders ilvl and CP when a stat map is supplied', () => {
  const embed = buildEvidenceEmbed(makeEntry(), 'https://cdn.example.test/e.png', {
    lang: 'vi',
    statMap: statMapFromRosterCharacters(ROSTER),
  });

  assert.equal(fieldValue(embed, 'ilvl'), '`1755.00`');
  assert.equal(fieldValue(embed, 'CP'), '`≈4820.12`');
  // Alt rows inherit the same class + ilvl + CP shape /la-check renders.
  assert.match(fieldValue(embed, 'Alt đang track'), /Bard \[Hanako\]\(\S+\) · `1730\.83` · CP `≈3311\.40`/u);
});

test('evidence card without a stat map keeps its previous shape', () => {
  // Every caller that has no roster data in hand must not gain a grid of
  // "N/A" slots · the upgrade is opt-in per callsite.
  const embed = buildEvidenceEmbed(makeEntry(), 'https://cdn.example.test/e.png', { lang: 'vi' });
  const names = inlineNames(embed);

  assert.equal(names.some((n) => n.includes('ilvl')), false);
  assert.equal(names.some((n) => n.includes('CP')), false);
  assert.equal(names.filter((n) => n !== ZWSP).length, 3);
  assert.doesNotMatch(fieldValue(embed, 'Alt đang track'), /CP/u);
});

test('the inline meta grid always fills whole three-column rows', () => {
  const statMap = statMapFromRosterCharacters(ROSTER);
  const cases = [
    buildEvidenceEmbed(makeEntry(), 'https://x.test/e.png', { lang: 'vi', statMap }),
    buildEvidenceEmbed(makeEntry(), 'https://x.test/e.png', { lang: 'vi', statMap, includeAddedBy: true }),
    buildEvidenceEmbed(makeEntry({ raid: '', addedAt: null }), 'https://x.test/e.png', { lang: 'vi', statMap }),
    buildEvidenceEmbed(makeEntry({ raid: '', addedAt: null }), 'https://x.test/e.png', { lang: 'vi' }),
  ];

  for (const embed of cases) {
    // A lone trailing inline field gets stretched to full width by
    // Discord, which is what knocked the old card out of alignment.
    assert.equal(inlineNames(embed).length % 3, 0, inlineNames(embed).join(' | '));
  }
});

test('added by joins the inline grid instead of trailing the card', () => {
  const embed = buildEvidenceEmbed(makeEntry(), 'https://x.test/e.png', {
    lang: 'vi',
    statMap: statMapFromRosterCharacters(ROSTER),
    includeAddedBy: true,
  });
  const names = embed.toJSON().fields.map((f) => f.name);

  assert.ok(names.indexOf('👤 Người thêm') < names.findIndex((n) => n.includes('Alt đang track')));
  assert.equal(inlineNames(embed).filter((n) => n !== ZWSP).length, 6);
});
