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
  assert.match(rendered.description, /^⛔ \*\*\[Altone\]\(\S+\)\*\*/u);
  assert.match(rendered.description, /alts: \[Alttwo\]\(\S+\)/u);
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

test('list-check card reports candidates rejected by identity verification', () => {
  const { embed } = buildListCheckEmbed({
    results: [{ name: 'Realname', identityVerified: true }],
    formattedLines: ['❓ Realname'],
    limitedNamesCount: 2,
    unverifiedCount: 1,
    mode: 'slash',
  });

  assert.match(embed.toJSON().description, /Skipped 1 unverified candidate/u);
});

test('a compact card speaks the elapsed line rather than labelling it', () => {
  // Compact chrome deliberately drops title, footer and timestamp. How
  // long the wait was is the one fact the rows above cannot carry, so it
  // is allowed back in alone rather than dragging the chrome with it.
  const { embed } = buildListCheckEmbed({
    results: [unlisted()],
    formattedLines: ['x'],
    limitedNamesCount: 1,
    mode: 'auto',
    elapsedMs: 4237,
  });
  const j = embed.toJSON();

  assert.match(j.footer.text, /^⏱️ /u);
  assert.match(j.footer.text, /4\.2s/u);
  assert.equal(j.title, undefined);
  assert.equal(j.timestamp, undefined);
  // The uppercase HUD label belongs to the full footer where it has
  // peers · alone under a sentence-case card it read as a fragment of a
  // different card, which is what this whole change is about.
  assert.doesNotMatch(j.footer.text, /TOOK|SRC|CLEAR|FLAGGED/u);
});

test('a compact card with no measurement keeps no footer at all', () => {
  for (const elapsedMs of [null, undefined, 0, -12]) {
    const { embed } = buildListCheckEmbed({
      results: [unlisted()],
      formattedLines: ['x'],
      limitedNamesCount: 1,
      mode: 'auto',
      elapsedMs,
    });
    // A clock that went backwards must print nothing, not "-0.0s".
    assert.equal(embed.toJSON().footer, undefined, String(elapsedMs));
  }
});

test('the full footer puts elapsed between the status and the hint', () => {
  const { embed } = buildListCheckEmbed({
    results: [unlisted()],
    formattedLines: ['x'],
    limitedNamesCount: 1,
    mode: 'slash',
    textRequest: true,
    elapsedMs: 1820,
  });
  const parts = embed.toJSON().footer.text.split(' · ');

  assert.match(parts[0], /^\/\//u, 'status kicker stays first');
  assert.ok(parts.includes('⏱️ TOOK 1.8s'));
  assert.ok(
    parts.indexOf('⏱️ TOOK 1.8s') < parts.findIndex((p) => p.startsWith('SRC')),
    'elapsed sits ahead of the source citation'
  );
});

test('elapsed rounds to one decimal because the extra digits are noise', () => {
  const seconds = (ms) => {
    const { embed } = buildListCheckEmbed({
      results: [unlisted()], formattedLines: ['x'], limitedNamesCount: 1,
      mode: 'auto', elapsedMs: ms,
    });
    return embed.toJSON().footer.text;
  };

  assert.match(seconds(4237), /\b4\.2s/u);
  assert.match(seconds(4249), /\b4\.2s/u);
  assert.match(seconds(340), /\b0\.3s/u);
});

test('the spoken line changes tone with how long the wait was', async () => {
  // Same shape as the cleanup notice's volume buckets. One line for every
  // duration would either over-apologise for a 3s read or shrug at 40s.
  const { TRANSLATIONS } = await import('../bot/locales/index.js');
  const pool = (key, secs) => TRANSLATIONS.en.dialogue.check.embed[key].variants
    .map((line) => line.replace('{seconds}', secs));
  const line = (ms) => buildListCheckEmbed({
    results: [unlisted()], formattedLines: ['x'], limitedNamesCount: 1,
    mode: 'auto', elapsedMs: ms,
  }).embed.toJSON().footer.text;

  // Sampled repeatedly because the pool picks at random · a single draw
  // could pass while the bucket boundary is wrong.
  for (let i = 0; i < 20; i += 1) {
    assert.ok(pool('elapsedQuick', '3.2').includes(line(3200)), 'fast read');
    assert.ok(pool('elapsedSteady', '12.0').includes(line(12000)), 'steady read');
    assert.ok(pool('elapsedSlow', '30.2').includes(line(30200)), 'slow read');
  }

  // Boundaries: 6s is still quick, 20s is still steady.
  assert.ok(pool('elapsedQuick', '6.0').includes(line(6000)));
  assert.ok(pool('elapsedSteady', '20.0').includes(line(20000)));
  assert.ok(pool('elapsedSlow', '20.1').includes(line(20100)));
});
