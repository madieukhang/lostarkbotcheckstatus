import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommands } from '../bot/commands.js';
import { getClassAutocompleteChoices, resolveClassId } from '../bot/models/Class.js';
import RosterCache from '../bot/models/RosterCache.js';

test('/la-search class option uses autocomplete instead of capped static choices', () => {
  const commands = buildCommands();
  const searchCommand = commands.find((cmd) => cmd.name === 'la-search');
  const classOption = searchCommand.options.find((opt) => opt.name === 'class');

  assert.equal(classOption.autocomplete, true);
  assert.equal(classOption.choices, undefined);
});

test('class autocomplete exposes classes beyond Discord static-choice cap', () => {
  assert.deepEqual(getClassAutocompleteChoices('wild'), [
    { name: 'Wildsoul', value: 'alchemist' },
  ]);

  const artistChoices = getClassAutocompleteChoices('artist').map((choice) => choice.name);
  assert.ok(artistChoices.includes('Artist'));
  assert.ok(getClassAutocompleteChoices('').length <= 25);
});

test('class resolver accepts display names, IDs, and loose spacing', () => {
  assert.equal(resolveClassId('Artist'), 'yinyangshi');
  assert.equal(resolveClassId('weather_artist'), 'weather_artist');
  assert.equal(resolveClassId('Soul Eater'), 'soul_eater');
  assert.equal(resolveClassId('unknown_new_class'), 'unknown_new_class');
  assert.equal(resolveClassId(''), null);
});

test('RosterCache name index is case-insensitive unique', () => {
  const indexes = RosterCache.schema.indexes();
  const nameIndex = indexes.find(([fields, options]) =>
    fields.name === 1 &&
    options.unique === true &&
    options.collation?.locale === 'en' &&
    options.collation?.strength === 2
  );

  assert.ok(nameIndex, 'expected unique case-insensitive name index');
});
