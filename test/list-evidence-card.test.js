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
  assert.match(fieldValue(embed, 'Alt đang track'), /Bard \[Hanako\]\(\S+\) · `1730\.83` · `≈3311\.40 CP`/u);
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

test('notice mode swaps the title bar for an Artist headline', () => {
  const embed = buildEvidenceEmbed(makeEntry(), '', {
    lang: 'vi',
    statMap: statMapFromRosterCharacters(ROSTER),
    headline: true,
    attachImage: false,
  }).toJSON();

  // Same shape a list-change broadcast uses: the list is named in the
  // title and the character in one spoken line under it.
  assert.match(embed.title, /Kết quả kiểm tra · Blacklist/u);
  assert.match(embed.description, /\[Tenshi\]/u);
  assert.match(embed.description, /Blacklist/u);
  // The name is already linked in that line, so the title drops its URL
  // rather than offering the same link twice.
  assert.equal(embed.url, undefined);
  // List would restate the headline.
  assert.equal(embed.fields.some((f) => f.name.includes('List')), false);
});

test('notice mode keeps evidence off the card entirely', () => {
  const withImage = buildEvidenceEmbed(makeEntry(), 'https://cdn.example.test/e.png', {
    lang: 'vi', headline: true, attachImage: false,
  }).toJSON();
  const withoutImage = buildEvidenceEmbed(makeEntry(), '', {
    lang: 'vi', headline: true, attachImage: false,
  }).toJSON();

  // No embedded screenshot, and no "evidence unavailable" field either ·
  // the button beside the card is the only evidence affordance.
  assert.equal(withImage.image, undefined);
  assert.equal(withoutImage.image, undefined);
  assert.equal(withoutImage.fields.some((f) => f.name.includes('Evidence')), false);

  // Detail mode is untouched and still embeds the screenshot.
  const detail = buildEvidenceEmbed(makeEntry(), 'https://cdn.example.test/e.png', { lang: 'vi' }).toJSON();
  assert.equal(detail.image.url, 'https://cdn.example.test/e.png');
});

test('notice mode names both sides when the hit came through a roster alt', () => {
  // /la-roster matches on every character in the roster, so the entry
  // that hit is often not the name the officer typed.
  const entry = decorateListEntry({
    name: 'Hanako',
    reason: 'Griefing report',
    allCharacters: ['Hanako', 'Tenshi'],
  }, 'black');
  const statMap = statMapFromRosterCharacters(ROSTER);
  const via = buildEvidenceEmbed(entry, '', {
    lang: 'vi', statMap, headline: true, attachImage: false, viaName: 'Tenshi',
  }).toJSON();

  // Both sides are named: what was typed, and what actually hit.
  assert.match(via.description, /\*\*Tenshi\*\* chung roster/u);
  assert.match(via.description, /\[Hanako\]/u);

  // Searching the blacklisted name itself keeps the direct wording, and
  // never mentions a second character. Matching is case-insensitive.
  const direct = buildEvidenceEmbed(entry, '', {
    lang: 'vi', statMap, headline: true, attachImage: false, viaName: 'hanako',
  }).toJSON();
  assert.doesNotMatch(direct.description, /Tenshi/u);
  assert.doesNotMatch(direct.description, /chung roster/u);
});
