import test from 'node:test';
import assert from 'node:assert/strict';

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
  // The matched name links out like every other character name.
  assert.match(lines[0], /via \*\*\[Mainchar\]\(\S+\)\*\*/);
  // CP carries its unit inside the badge.
  assert.match(lines[0], /`90000 CP`/);
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
