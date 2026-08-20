import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

import { buildCommands } from '../bot/commands/index.js';
import { buildMultiaddTemplate } from '../bot/services/multiadd/template.js';
import {
  getRaidAutocompleteChoices,
  getRaidChoices,
  getSelectableRaidValues,
  resolveListAddRaidLabel,
  resolveRaidLabel,
} from '../bot/models/Raid.js';

const { createAutocompleteRoutes } = await import('../bot/app/interaction-router.js');

function findListOption(subcommandName, optionName) {
  const list = buildCommands().find((command) => command.name === 'la-list');
  const subcommand = list.options.find((option) => option.name === subcommandName);
  return subcommand.options.find((option) => option.name === optionName);
}

test('/la-list add and edit raid options use dynamic autocomplete', () => {
  const addRaid = findListOption('add', 'raid');
  const editRaid = findListOption('edit', 'raid');

  assert.equal(addRaid.autocomplete, true);
  assert.equal(addRaid.max_length, 100);
  assert.equal(addRaid.choices, undefined);
  assert.equal(editRaid.autocomplete, true);
  assert.equal(editRaid.max_length, 100);
  assert.equal(editRaid.choices, undefined);
});

test('limited Brel choice uses a durable value and expires at Vietnam midnight', () => {
  const beforeCutoff = { now: '2026-09-01T16:59:59.999Z' };
  const atCutoff = { now: '2026-09-01T17:00:00.000Z' };

  assert.deepEqual(
    getRaidChoices(beforeCutoff).find(({ value }) => value === 'Brel Extreme (Limited)'),
    {
      name: 'Brel Extreme (Limited Time) Choose',
      value: 'Brel Extreme (Limited)',
    },
  );
  assert.equal(
    getRaidChoices(atCutoff).some(({ value }) => value === 'Brel Extreme (Limited)'),
    false,
  );
  assert.equal(
    getSelectableRaidValues(atCutoff).includes('Brel Extreme (Limited)'),
    false,
  );
});

test('Mordum is hidden from new choices while historical raid values still normalize', () => {
  assert.equal(getRaidChoices().some(({ value }) => value === 'Mordum Hard'), false);
  assert.deepEqual(getRaidAutocompleteChoices('Mordum'), []);
  assert.equal(resolveRaidLabel('Mordum Hard'), 'Mordum Hard');
  assert.equal(
    resolveRaidLabel('Brel Extreme (Limited Time) Choose'),
    'Brel Extreme (Limited)',
  );
  assert.equal(resolveRaidLabel('Brel Extreme (Limited)'), 'Brel Extreme (Limited)');
});

test('normal raids are hidden from selectors but remain valid historical values', () => {
  const normalRaids = ['Act4 Nor', 'Kazeros Nor', 'Secra Nor'];
  const selectableValues = getSelectableRaidValues();

  for (const raid of normalRaids) {
    assert.equal(selectableValues.includes(raid), false);
    assert.equal(resolveRaidLabel(raid), raid);
  }
  assert.deepEqual(getRaidAutocompleteChoices('Nor'), []);
  assert.equal(selectableValues.includes('Secra Hard'), true);
  assert.equal(selectableValues.includes('Secra NM'), true);
  assert.deepEqual(
    selectableValues.filter((raid) => raid.startsWith('Horizon ')),
    ['Horizon Lv1', 'Horizon Lv2', 'Horizon Lv3'],
  );
});

test('Brel autocomplete hides at the cutoff but keeps the selected storage label', () => {
  assert.deepEqual(
    getRaidAutocompleteChoices('Brel', { now: '2026-09-01T16:59:59.999Z' }),
    [{
      name: 'Brel Extreme (Limited Time) Choose',
      value: 'Brel Extreme (Limited)',
    }],
  );
  assert.deepEqual(
    getRaidAutocompleteChoices('Brel Extreme (Limited)', {
      allowCustom: true,
      now: '2026-09-01T17:00:00.000Z',
    }),
    [],
  );
});

test('multiadd raid dropdown follows the same retired and limited choice policy', async () => {
  const ExcelJS = (await import('exceljs')).default;
  const readRaidFormula = async (now) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await buildMultiaddTemplate({ now }));
    return workbook.getWorksheet('Entries').getCell('D9').dataValidation.formulae[0];
  };

  const beforeCutoff = await readRaidFormula('2026-09-01T16:59:59.999Z');
  assert.match(beforeCutoff, /Brel Extreme \(Limited\)/);
  assert.doesNotMatch(beforeCutoff, /Mordum Hard/);

  const atCutoff = await readRaidFormula('2026-09-01T17:00:00.000Z');
  assert.doesNotMatch(atCutoff, /Brel Extreme \(Limited\)/);
  assert.doesNotMatch(atCutoff, /Mordum Hard/);
});

test('watchlist raid autocomplete offers the typed custom label plus canonical matches', () => {
  assert.deepEqual(getRaidAutocompleteChoices('Secra', { allowCustom: true }), [
    { name: 'Custom · Secra', value: 'Secra' },
    { name: 'Secra Hard', value: 'Secra Hard' },
    { name: 'Secra NM', value: 'Secra NM' },
  ]);
  assert.deepEqual(getRaidAutocompleteChoices('Custom Gate', { allowCustom: false }), []);
});

test('raid normalization accepts custom labels only when watchlist opts in', () => {
  assert.equal(resolveRaidLabel('  secra hard  '), 'Secra Hard');
  assert.equal(resolveRaidLabel('  Event Gate  ', { allowCustom: true }), 'Event Gate');
  assert.equal(resolveRaidLabel('Event Gate'), null);
  assert.equal(resolveRaidLabel('   ', { allowCustom: true }), '');
  assert.equal(resolveListAddRaidLabel('watch', 'Event Gate'), 'Event Gate');
  assert.equal(resolveListAddRaidLabel('black', 'Event Gate'), null);
  assert.equal(resolveListAddRaidLabel('white', 'Event Gate'), null);
});

test('la-list autocomplete route supports edit and custom add for type:watch', async () => {
  const route = createAutocompleteRoutes()['la-list'];
  const responses = [];
  let subcommand = 'add';
  const interaction = {
    options: {
      getFocused: () => ({ name: 'raid', value: 'Event Gate' }),
      getSubcommand: () => subcommand,
      getString: () => 'watch',
    },
    respond: async (choices) => responses.push(choices),
  };

  await route(interaction);
  assert.deepEqual(responses[0], [{ name: 'Custom · Event Gate', value: 'Event Gate' }]);

  interaction.options.getString = () => 'black';
  await route(interaction);
  assert.deepEqual(responses[1], []);

  subcommand = 'edit';
  interaction.options.getFocused = () => ({ name: 'raid', value: 'Secra Hard' });
  await route(interaction);
  assert.deepEqual(responses[2], [{ name: 'Secra Hard', value: 'Secra Hard' }]);
});
