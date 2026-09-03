import test from 'node:test';
import assert from 'node:assert/strict';

import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { formatCheckResults } from '../bot/services/list-check/format.js';

test('formatCheckResults sorts same-priority DPS before supports', () => {
  const lines = formatCheckResults([
    {
      name: 'Supportchar',
      blackEntry: { name: 'Supportchar', reason: 'bad', scope: 'global' },
      snapClassName: 'Bard',
      snapItemLevel: 1700,
    },
    {
      name: 'Dpschar',
      blackEntry: { name: 'Dpschar', reason: 'bad', scope: 'global' },
      snapClassName: 'Berserker',
      snapItemLevel: 1700,
    },
  ]);

  assert.match(lines[0], /Dpschar/);
  assert.match(lines[1], /Supportchar/);
});

test('formatCheckResults renders roster-match branch context', () => {
  const lines = formatCheckResults([
    {
      name: 'Altchar',
      blackEntry: { name: 'Mainchar', reason: 'RMT', raid: 'Act 4 Hard', scope: 'server' },
      snapClassName: 'Berserker',
      snapItemLevel: 1720,
      snapCombatScore: '90000',
    },
  ]);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^⛔/u);
  assert.match(lines[0], /\(Local\)/);
  // The report stays together, while the indirect match gets its own line
  // immediately after it so a long reason cannot bury the roster link.
  assert.match(
    lines[0],
    /\n   ↳ \*RMT\* · `Act 4 Hard`\n   ↳ via \*\*\[Mainchar\]\(\S+\)\*\*/u,
  );
  // CP carries its unit inside the badge.
  assert.match(lines[0], /`90000 CP`/);
});

test('formatCheckResults does not add a via line for a direct list hit', () => {
  const [line] = formatCheckResults([{
    name: 'Mainchar',
    blackEntry: {
      name: 'Mainchar',
      reason: 'A deliberately long report remains beside its raid',
      raid: 'Act 4 Hard',
      scope: 'global',
    },
    snapClassName: 'Berserker',
    snapItemLevel: 1720,
  }]);

  assert.match(
    line,
    /\n   ↳ \*A deliberately long report remains beside its raid\* · `Act 4 Hard`$/u,
  );
  assert.doesNotMatch(line, /\n   ↳ (?:via|roster alt) /u);
});

test('formatCheckResults groups photographed characters backed by one roster entry', () => {
  const names = [
    'Dbbpallylastone',
    'Anotherpallydbb',
    'Holypaladindbb',
    'Pallydbbswift',
    'Dbbpaladin',
    'Paladindbb',
  ];
  const sharedEntry = {
    _id: 'a'.repeat(24),
    name: 'Holynightdbb',
    reason: 'Same roster report',
    raid: 'Act4 Nor',
    scope: 'global',
    allCharacters: [...names, 'Offscreenalt'],
  };
  const results = names.map((name, index) => ({
    inputName: name,
    inputSource: 'ocr',
    name,
    blackEntry: sharedEntry,
    whiteEntry: null,
    watchEntry: null,
    trustedEntry: { _id: `${index + 1}`.repeat(24), name },
    matchDetails: { black: { kind: 'tracked', matchedName: name } },
    discoveredAlts: [],
    snapClassName: '',
    snapItemLevel: 1766.67 - index,
  }));

  const lines = formatCheckResults(results, 'vi');

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^⛔ \*\*\[Dbbpallylastone\]\(\S+\)\*\*/u);
  assert.match(lines[0], /🛡️/u);
  assert.match(lines[0], /via \*\*\[Holynightdbb\]\(\S+\)\*\*/u);
  assert.equal((lines[0].match(/Same roster report/gu) || []).length, 1);
  // Alt names link out too, so the officer can verify each one.
  assert.match(lines[0], /alt: \[Anotherpallydbb\]\(\S+\), \[Holypaladindbb\]\(\S+\), \[Pallydbbswift\]\(\S+\) \*\+3 tên khác\*/u);
  assert.doesNotMatch(lines[0], /6 tên cùng roster|Trong ảnh:/u);
});

test('formatCheckResults does not merge distinct list entries with similar roster labels', () => {
  const makeResult = (name, id) => ({
    name,
    blackEntry: {
      _id: id,
      name: 'Sharedlabel',
      reason: 'Separate report',
      allCharacters: ['Altone', 'Alttwo'],
    },
    snapClassName: '',
    snapItemLevel: 1700,
  });

  const lines = formatCheckResults([
    makeResult('Altone', 'b'.repeat(24)),
    makeResult('Alttwo', 'c'.repeat(24)),
  ]);

  assert.equal(lines.length, 2);
});

test('formatCheckResults shows OCR correction and the roster path used to confirm a list hit', () => {
  const lines = formatCheckResults([{
    inputName: 'Altchxr',
    inputSource: 'ocr',
    name: 'Altchar',
    blackEntry: { name: 'Mainchar', reason: 'RMT', scope: 'global' },
    matchDetails: {
      black: { kind: 'roster', matchedName: 'Rosteralt' },
    },
    discoveredAlts: ['Rosteralt'],
    snapClassName: 'Berserker',
    snapItemLevel: 1720,
  }]);

  assert.match(lines[0], /OCR \*\*Altchxr\*\* → lostark\.bible \*\*Altchar\*\*/);
  assert.match(lines[0], /roster alt \*\*\[Rosteralt\]\(\S+\)\*\* → entry \*\*\[Mainchar\]\(\S+\)\*\*/);
});

test('formatCheckResults does not label a typed-name correction as OCR', () => {
  const [line] = formatCheckResults([{
    inputName: 'Altchxr',
    inputSource: 'text',
    name: 'Altchar',
    snapClassName: '',
    snapItemLevel: 0,
  }]);

  assert.match(line, /typed \*\*Altchxr\*\* → lostark\.bible \*\*Altchar\*\*/);
  assert.doesNotMatch(line, /OCR/);
});

test('formatCheckResults keeps list-state precedence without empty detail branches', () => {
  const lines = formatCheckResults([
    {
      name: 'Allstates',
      blackEntry: { name: 'Allstates', scope: 'server' },
      watchEntry: { name: 'Allstates' },
      whiteEntry: { name: 'Allstates' },
      trustedEntry: { name: 'Allstates' },
    },
    { name: 'Watchchar', watchEntry: { name: 'Watchchar' } },
    { name: 'Whitechar', whiteEntry: { name: 'Whitechar' } },
    { name: 'Trustedchar', trustedEntry: { name: 'Trustedchar' } },
    { name: 'Unknownchar' },
  ]);

  const lineFor = (name) => lines.find((line) => line.includes(name));

  assert.match(lineFor('Allstates'), /^⛔.*\(Local\).*🛡️/u);
  assert.doesNotMatch(lineFor('Allstates'), /↳/u);
  assert.match(lineFor('Watchchar'), /^⚠️/u);
  assert.match(lineFor('Whitechar'), /^✅/u);
  assert.match(lineFor('Trustedchar'), /^🛡️/u);
  assert.match(lineFor('Unknownchar'), /^❓/u);
});

test('related names carry their class once the check has snapshots for them', () => {
  // The searched name always had its class; the entry it matched through
  // and the alts under it were the bare names on an otherwise icon-led
  // row. relatedClasses is what the check service loads for them.
  const item = {
    name: 'Hanako',
    snapClassName: 'Bard',
    snapItemLevel: 1770,
    blackEntry: {
      name: 'Tenshi',
      reason: 'griefing',
      allCharacters: ['Tenshi', 'Mikazuki'],
    },
    matchDetails: { black: { kind: 'roster', matchedName: 'Tenshi' } },
  };

  const [bare] = formatCheckResults([{ ...item }], 'vi');
  assert.doesNotMatch(bare, /Souleater/u);

  const previousEmoji = {
    Bard: CLASS_EMOJI_MAP.Bard,
    Souleater: CLASS_EMOJI_MAP.Souleater,
    Reaper: CLASS_EMOJI_MAP.Reaper,
  };
  Object.assign(CLASS_EMOJI_MAP, {
    Bard: '<:bard:101>',
    Souleater: '<:souleater:102>',
    Reaper: '<:reaper:103>',
  });
  try {
    const [enriched] = formatCheckResults([{
      ...item,
      relatedClasses: { tenshi: 'Souleater', mikazuki: 'Reaper' },
    }], 'vi');
    assert.match(enriched, /<:souleater:102> \[Tenshi\]/u);
    assert.match(enriched, /<:reaper:103> \[Mikazuki\]/u);
    // The searched name keeps exactly one class prefix, from snapClassName.
    assert.equal((enriched.match(/<:bard:101>/gu) || []).length, 1);
  } finally {
    Object.assign(CLASS_EMOJI_MAP, previousEmoji);
  }
});
