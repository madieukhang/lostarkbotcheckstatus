import test from 'node:test';
import assert from 'node:assert/strict';

import { parseAdditionalNames } from '../bot/utils/names.js';

test('parseAdditionalNames returns empty result for falsy input', () => {
  assert.deepEqual(parseAdditionalNames(''), { added: [], duplicates: [] });
  assert.deepEqual(parseAdditionalNames(null), { added: [], duplicates: [] });
  assert.deepEqual(parseAdditionalNames(undefined), { added: [], duplicates: [] });
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
  assert.deepEqual(parseAdditionalNames(123), { added: [], duplicates: [] });
  assert.deepEqual(parseAdditionalNames({}), { added: [], duplicates: [] });
  assert.deepEqual(parseAdditionalNames([]), { added: [], duplicates: [] });
});
