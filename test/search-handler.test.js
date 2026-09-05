import test from 'node:test';
import assert from 'node:assert/strict';

import { pickEvidenceEntry } from '../bot/handlers/search/evidence.js';
import { buildSearchResultEmbed } from '../bot/handlers/search/ui.js';
import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { t } from '../bot/services/i18n/index.js';

test('search summary counts names absent from the list database without double subtraction', () => {
  const embed = buildSearchResultEmbed({
    name: 'Ains',
    minIlvl: 1700,
    maxIlvl: null,
    classFilter: null,
    results: [
      {
        name: 'Ainslinn',
        cls: 'bard',
        itemLevel: 1700,
        black: { name: 'Ainslinn', reason: 'bad' },
        white: null,
        watch: null,
        trusted: { name: 'Ainslinn', reason: 'known' },
      },
      {
        name: 'Cleanalt',
        cls: 'bard',
        itemLevel: 1700,
        black: null,
        white: null,
        watch: null,
        trusted: null,
      },
    ],
  });

  const json = embed.toJSON();
  const description = json.description;
  // The total lives in the compact heading; the description opens with the
  // per-list breakdown instead of restating the count.
  assert.match(json.author.name, /2 matches/);
  assert.equal(json.title, undefined);
  assert.doesNotMatch(description, /Found \*\*2\*\*/);
  assert.match(description, /⛔ \*\*1\*\*/);
  assert.match(description, /🛡️ \*\*1\*\*/);
  assert.match(description, /❓ \*\*1\*\* not in list DB/);
  assert.doesNotMatch(description, /\bclean\b/i);
});

test('search evidence picker skips earlier list entries without images', () => {
  const watchEntry = { name: 'Ainslinn', reason: 'watch', imageMessageId: '123' };
  const result = {
    name: 'Ainslinn',
    black: { name: 'Ainslinn', reason: 'black-no-image' },
    white: null,
    watch: watchEntry,
  };

  assert.equal(pickEvidenceEntry(result), watchEntry);
});

test('search result row shows evidence marker when later flagged entry has image', () => {
  const embed = buildSearchResultEmbed({
    name: 'Ains',
    minIlvl: 1700,
    maxIlvl: null,
    classFilter: null,
    results: [{
      name: 'Ainslinn',
      cls: 'bard',
      itemLevel: 1700,
      black: { name: 'Ainslinn', reason: 'black-no-image' },
      white: null,
      watch: { name: 'Ainslinn', reason: 'watch', imageMessageId: '123' },
      trusted: null,
    }],
  });

  assert.match(embed.toJSON().description, /📎/u);
});

test('search treats composed and decomposed names as the same direct list hit', () => {
  const embed = buildSearchResultEmbed({
    name: 'Zoë',
    minIlvl: 1700,
    maxIlvl: null,
    classFilter: null,
    results: [{
      name: 'Zoë',
      cls: 'bard',
      itemLevel: 1700,
      black: { name: 'Zoe\u0308', reason: 'direct hit' },
      white: null,
      watch: null,
      trusted: null,
    }],
  });

  assert.doesNotMatch(embed.toJSON().description, /\bvia\b/iu);
});

test('search uses the check-card name, report, via and alt hierarchy in every locale', () => {
  for (const lang of ['vi', 'en', 'jp']) {
    const result = {
      name: 'Searchalt', cls: 'holyknight', itemLevel: 1730.83, combatScore: '≈3307.21',
      black: {
        name: 'Listedmain', reason: 'Sample report', raid: 'Kazeros Hard',
        allCharacters: ['Searchalt', 'Listedmain', 'Altone', 'Alttwo', 'Altthree', 'Fourthalt'],
      },
    };
    const snapshotMap = new Map(['Listedmain', 'Altone', 'Alttwo', 'Altthree'].map(name => (
      [name.toLowerCase(), { name, classId: 'holyknight' }]
    )));
    const json = buildSearchResultEmbed({ name: 'Searchalt', results: [result], minIlvl: 1700, maxIlvl: null, classFilter: null, lang, snapshotMap }).toJSON();
    const lines = json.description.split('\n');
    assert.match(lines[0], /^⛔ .*\*\*\[Searchalt\]\(\S+\)\*\* · `1730\.83` · `≈3307\.21 CP`$/u);
    assert.equal(lines[1], '   ↳ *Sample report* · `Kazeros Hard`');
    assert.match(lines[2], /\*\*.*\[Listedmain\]\(\S+\)\*\*/u);
    assert.ok(lines[3].includes('[Altone]('));
    assert.ok(lines[3].includes('[Alttwo]('));
    assert.ok(lines[3].includes('[Altthree]('));
    assert.ok(!lines[3].includes('[Fourthalt]('));
    assert.ok(!lines[3].includes('Listedmain'));
    assert.ok(!lines[3].includes('Searchalt'));
    assert.ok(lines[2].includes(CLASS_EMOJI_MAP.Paladin || 'Paladin'));
    assert.ok(lines[3].includes(CLASS_EMOJI_MAP.Paladin || 'Paladin'));
    assert.ok(json.author.name.includes('Searchalt'));
    assert.equal(json.title, undefined);
    assert.ok(json.footer.text.includes('1700'));
  }
});

test('search keeps distinct names and search order even when two hits share one list entry', () => {
  const entry = { _id: 'shared-entry', name: 'Main', reason: 'report' };
  const results = [
    { name: 'Clean', cls: 'bard', itemLevel: 1700 },
    { name: 'Firstalt', cls: 'bard', itemLevel: 1700, black: entry },
    { name: 'Secondalt', cls: 'holyknight', itemLevel: 1700, black: entry },
  ];
  const { author, description } = buildSearchResultEmbed({ name: 'Search', results, minIlvl: 1700, maxIlvl: null, classFilter: null }).toJSON();
  assert.match(author.name, /3 matches/);
  assert.match(description, /\*\*1\.\*\* ❓ .*\*\*\[Clean\]/u);
  assert.match(description, /\*\*2\.\*\* ⛔ .*\*\*\[Firstalt\]/u);
  assert.match(description, /\*\*3\.\*\* ⛔ .*\*\*\[Secondalt\]/u);
  assert.ok(description.indexOf('[Clean](') < description.indexOf('[Firstalt]('));
  assert.ok(description.indexOf('[Firstalt](') < description.indexOf('[Secondalt]('));
});

test('long search cards fit complete result blocks and disclose the omitted count', () => {
  const results = Array.from({ length: 15 }, (_, index) => ({
    name: `Result${index}`, cls: 'bard', itemLevel: 1730,
    black: {
      name: `Main${index}`, reason: 'A long sample report. '.repeat(16), raid: 'Kazeros Hard',
      allCharacters: [`Result${index}`, `Main${index}`, `Altone${index}`, `Alttwo${index}`, `Altthree${index}`],
    },
  }));
  for (const lang of ['vi', 'en', 'jp']) {
    const options = { name: 'Result', results, minIlvl: 1700, maxIlvl: null, classFilter: null, lang };
    const { description } = buildSearchResultEmbed(options).toJSON();
    const shown = [...description.matchAll(/^\*\*\d+\.\*\*/gm)].length;
    assert.ok(shown > 0 && shown < results.length);
    assert.ok(description.length <= 4096);
    assert.ok(description.includes(t('dialogue.search.moreResults', lang, { count: results.length - shown })));
    for (const [index, result] of results.entries()) {
      if (index < shown) {
        const single = buildSearchResultEmbed({ ...options, results: [result] }).toJSON().description;
        assert.ok(description.includes(`**${index + 1}.** ${single}`), 'visible records must be complete');
      } else {
        assert.ok(!description.includes(`[${result.name}](`));
      }
    }
  }
});
