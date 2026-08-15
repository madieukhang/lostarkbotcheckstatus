import test from 'node:test';
import assert from 'node:assert/strict';

import { formatCheckResults } from '../bot/services/list-check/format.js';
import { buildListCheckEmbed } from '../bot/utils/listCheckEmbed.js';

// Minimal result objects - buildListCheckEmbed only reads which *Entry is set.
const watch = () => ({ watchEntry: { name: 'A' } });
const trusted = () => ({ trustedEntry: { name: 'B' } });
const unlisted = () => ({});

test('merged header: kicker carries mode + count, title IS the breakdown', () => {
  const results = [watch(), trusted(), trusted(), unlisted(), unlisted(), unlisted(), unlisted(), unlisted()];
  const { embed } = buildListCheckEmbed({
    results,
    formattedLines: ['⚠️ **A** · `1730`', '🛡️ **B** · `1750`'],
    limitedNamesCount: 8,
    mode: 'auto',
  });
  const j = embed.toJSON();
  assert.equal(j.author.name, '// AUTO-CHECK · 8 NAMES');
  // title = the breakdown itself; leading emoji is the strongest outcome present
  assert.equal(j.title, '⚠️ 1 · 🛡️ 2 · ❓ 5 not listed');
  // the old "Outcome:" header line is gone - description leads with the name list
  assert.ok(!j.description.includes('Outcome:'));
  assert.ok(j.description.includes('⚠️ **A**'));
  // footer is a HUD status line + the source citation
  assert.match(j.footer.text, /^\/\/ FLAGGED 1/u);
  assert.match(j.footer.text, /blacklist \+ whitelist \+ watchlist \+ trusted/u);
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

test('footer uses typed-input confirmation copy outside the screenshot flow', () => {
  const { embed } = buildListCheckEmbed({
    results: [{ inputName: 'Altchxr', inputSource: 'text', name: 'Altchar' }],
    formattedLines: ['❓ Altchar'],
    limitedNamesCount: 1,
    mode: 'auto',
    lang: 'vi',
  });

  const footer = embed.toJSON().footer.text;
  assert.match(footer, /Đã hiệu chỉnh 1 tên nhập · đối chiếu lại tên gốc/u);
  assert.doesNotMatch(footer, /OCR/u);
});
