import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCheckResults } from '../bot/services/list-check/format.js';
import { buildListCheckEmbed } from '../bot/utils/listCheckEmbed.js';

// Minimal result objects - buildListCheckEmbed only reads which *Entry is set.
const watch = () => ({ watchEntry: { name: 'A' } });
const trusted = () => ({ trustedEntry: { name: 'B' } });
const unlisted = () => ({});

test('auto text card uses the compact search author and omits redundant chrome', () => {
  const results = [watch(), trusted(), trusted(), unlisted(), unlisted(), unlisted(), unlisted(), unlisted()];
  const { embed } = buildListCheckEmbed({
    results,
    formattedLines: ['⚠️ **A** · `1730`', '🛡️ **B** · `1750`'],
    limitedNamesCount: 8,
    mode: 'auto',
  });
  const j = embed.toJSON();
  assert.equal(j.author.name, '🔎 Here is the check based on the name you sent.');
  assert.equal(j.title, undefined);
  assert.equal(j.footer, undefined);
  assert.equal(j.timestamp, undefined);
  assert.ok(!j.description.includes('Outcome:'));
  assert.ok(j.description.includes('⚠️ **A**'));
});

test('slash mode kicker + all-clear footer (0 flagged -> // CLEAR)', () => {
  const results = [trusted(), unlisted()];
  const { embed } = buildListCheckEmbed({
    results,
    formattedLines: ['🛡️ **B**', '❓ C'],
    limitedNamesCount: 2,
    mode: 'slash',
  });
  const j = embed.toJSON();
  assert.equal(j.author.name, '// LIST CHECK · 2 NAMES');
  assert.equal(j.title, '🛡️ 1 · ❓ 1 not listed');
  assert.match(j.footer.text, /^\/\/ CLEAR/u);
});

test('OCR image card uses the compact camera author and omits redundant chrome', () => {
  const sharedEntry = {
    _id: 'd'.repeat(24),
    name: 'Rosterprimary',
    reason: 'Shared report',
    allCharacters: ['Altone', 'Alttwo'],
  };
  const results = [
    {
      inputName: 'Altone',
      inputSource: 'ocr',
      name: 'Altone',
      blackEntry: sharedEntry,
      snapClassName: '',
      snapItemLevel: 1720,
    },
    {
      inputName: 'Alttwo',
      inputSource: 'ocr',
      name: 'Alttwo',
      blackEntry: sharedEntry,
      snapClassName: '',
      snapItemLevel: 1710,
    },
  ];
  const formattedLines = formatCheckResults(results, 'vi');
  const { embed, counts } = buildListCheckEmbed({
    results,
    formattedLines,
    limitedNamesCount: 2,
    mode: 'auto',
    lang: 'vi',
  });

  const rendered = embed.toJSON();
  assert.equal(counts.black, 1);
  assert.equal(rendered.author.name, '📸 Danh sách chụp dựa trên ảnh cậu gửi nè.');
  assert.equal(rendered.title, undefined);
  assert.equal(rendered.footer, undefined);
  assert.equal(rendered.timestamp, undefined);
  assert.match(rendered.description, /^⛔ \*\*Altone\*\*/u);
  assert.match(rendered.description, /alt: Alttwo/u);
  assert.doesNotMatch(rendered.description, /2 tên cùng roster|Trong ảnh:/u);
});

test('Vietnamese auto text card uses the compact name-based author', () => {
  const { embed } = buildListCheckEmbed({
    results: [{ inputName: 'Altchxr', inputSource: 'text', name: 'Altchar' }],
    formattedLines: ['❓ Altchar'],
    limitedNamesCount: 1,
    mode: 'auto',
    lang: 'vi',
  });

  const rendered = embed.toJSON();
  assert.equal(rendered.author.name, '🔎 Danh sách kiểm tra dựa trên tên cậu gửi nè.');
  assert.equal(rendered.title, undefined);
  assert.equal(rendered.footer, undefined);
  assert.equal(rendered.timestamp, undefined);
});
