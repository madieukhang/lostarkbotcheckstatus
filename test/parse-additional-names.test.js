import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNameKeyMap,
  normalizeCharacterName,
  normalizeNameKey,
  normalizeNameList,
  normalizeOcrCharacterName,
  parseAdditionalNames,
} from '../bot/utils/names.js';

test('normalizeNameKey gives composed and decomposed names one identity', () => {
  assert.equal(normalizeNameKey('  ZOE\u0308  '), 'zoë');
  assert.equal(normalizeNameKey('Zoë'), 'zoë');
});

test('normalizeNameList preserves first-seen order while deduping Unicode identities', () => {
  assert.deepEqual(
    normalizeNameList([' Zoe\u0308 ', 'OTHER', 'Zoë', '', null, 123, 'other']),
    ['Zoë', 'OTHER'],
  );
});

test('buildNameKeyMap indexes records with the same Unicode identity contract', () => {
  const snapshot = { name: 'Zoe\u0308', itemLevel: 1700 };
  assert.equal(buildNameKeyMap([snapshot]).get('zoë'), snapshot);
});

test('parseAdditionalNames returns empty result for falsy input', () => {
  assert.deepEqual(parseAdditionalNames(''), { added: [], duplicates: [], invalid: [] });
  assert.deepEqual(parseAdditionalNames(null), { added: [], duplicates: [], invalid: [] });
  assert.deepEqual(parseAdditionalNames(undefined), { added: [], duplicates: [], invalid: [] });
});

test('parseAdditionalNames sets aside pieces that are not character names', () => {
  const result = parseAdditionalNames('Goodalt, X](https://evil.test), A, Bad.name');
  assert.deepEqual(result.added, ['Goodalt']);
  assert.deepEqual(result.invalid, ['X](https://evil.test)', 'A', 'Bad.name']);
});

test('parseAdditionalNames splits, trims, and title-cases each name', () => {
  const result = parseAdditionalNames(' foo , bAr ,BAZ');
  assert.deepEqual(result.added, ['Foo', 'Bar', 'Baz']);
  assert.deepEqual(result.duplicates, []);
});

test('parseAdditionalNames drops empty pieces from extra commas', () => {
  const result = parseAdditionalNames('foo,,bar,');
  assert.deepEqual(result.added, ['Foo', 'Bar']);
});

test('parseAdditionalNames dedupes within input (case-insensitive)', () => {
  const result = parseAdditionalNames('Foo,FOO,foo,Bar');
  assert.deepEqual(result.added, ['Foo', 'Bar']);
});

test('parseAdditionalNames flags duplicates against existing allCharacters', () => {
  const result = parseAdditionalNames(
    'NewAlt, KnownAlt, AnotherNew',
    ['knownalt', 'OldAlt']
  );
  assert.deepEqual(result.added, ['Newalt', 'Anothernew']);
  assert.deepEqual(result.duplicates, ['Knownalt']);
});

test('parseAdditionalNames flags duplicate against entry primary name', () => {
  const result = parseAdditionalNames('Foo, Bar', [], 'foo');
  assert.deepEqual(result.added, ['Bar']);
  assert.deepEqual(result.duplicates, ['Foo']);
});

test('parseAdditionalNames partitions added vs duplicates correctly', () => {
  const result = parseAdditionalNames(
    'Apple, Banana, Cherry, Apple',
    ['banana'],
    'cherry'
  );
  // Apple is new; Banana matches existing; Cherry matches primary; second
  // Apple is dropped as a within-input duplicate, not surfaced.
  assert.deepEqual(result.added, ['Apple']);
  assert.deepEqual(result.duplicates, ['Banana', 'Cherry']);
});

test('parseAdditionalNames returns empty when all names are duplicates', () => {
  const result = parseAdditionalNames(
    'Foo, Bar',
    ['foo', 'BAR']
  );
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.duplicates, ['Foo', 'Bar']);
});

test('parseAdditionalNames handles non-string input gracefully', () => {
  assert.deepEqual(parseAdditionalNames(123), { added: [], duplicates: [], invalid: [] });
  assert.deepEqual(parseAdditionalNames({}), { added: [], duplicates: [], invalid: [] });
  assert.deepEqual(parseAdditionalNames([]), { added: [], duplicates: [], invalid: [] });
});

test('normalizeCharacterName canonicalizes detached diaeresis marks from OCR', () => {
  assert.equal(normalizeCharacterName('zoe\u0308'), 'Zoë');
  assert.equal(normalizeCharacterName('zoe\u00A8'), 'Zoë');
  assert.equal(normalizeCharacterName('zoe \u0308'), 'Zoë');
});

test('normalizeOcrCharacterName repairs Lost Ark umlaut OCR split artifacts', () => {
  assert.equal(normalizeOcrCharacterName('b\u00E1nhcanhci\u00F9a'), 'B\u00E1nhcanhc\u00FCa');
  assert.equal(normalizeOcrCharacterName('B\u00E1nhcanhci\u00F9a'), 'B\u00E1nhcanhc\u00FCa');
  assert.equal(normalizeOcrCharacterName('b\u00E1nhcanhc\u00ECua'), 'B\u00E1nhcanhc\u00FCa');
  assert.equal(normalizeOcrCharacterName('hailiu\u0300a'), 'Hail\u00FCa');
});

test('normalizeCharacterName repairs the observed full-name stem on any source', () => {
  assert.equal(normalizeCharacterName('b\u00E1nhcanhc\u00F9a'), 'B\u00E1nhcanhc\u00FCa');
  assert.equal(normalizeCharacterName('b\u00E1nhcanh\u00F9a'), 'B\u00E1nhcanhc\u00FCa');
});

test('normalizeCharacterName keeps a typed grave accent beside an i', () => {
  assert.equal(normalizeCharacterName('Nh\u00ECu'), 'Nh\u00ECu');
  assert.equal(normalizeCharacterName('D\u00ECuxinh'), 'D\u00ECuxinh');
  assert.equal(normalizeCharacterName('Li\u00F9na'), 'Li\u00F9na');
});

test('normalizeCharacterName removes OCR-inserted spaces inside character names', () => {
  assert.equal(normalizeCharacterName('Gunlancer rrrrrrrr'), 'Gunlancerrrrrrrrr');
  assert.equal(normalizeCharacterName('Qy oir'), 'Qyoir');
  assert.equal(normalizeCharacterName('Qyo ir'), 'Qyoir');
});
