import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DISCORD_TOKEN = 'test';
process.env.CHANNEL_ID = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/test';

import { buildCommands } from '../bot/commands/index.js';
import {
  getRaidAutocompleteChoices,
  getRaidChoices,
  resolveListAddRaidLabel,
  resolveRaidLabel,
} from '../bot/models/Raid.js';

const { createAutocompleteRoutes } = await import('../bot/app/interaction-router.js');

function findListOption(subcommandName, optionName) {
  const list = buildCommands().find((command) => command.name === 'la-list');
  const subcommand = list.options.find((option) => option.name === subcommandName);
  return subcommand.options.find((option) => option.name === optionName);
}

test('/la-list add raid is free-form autocomplete while edit keeps canonical choices', () => {
  const addRaid = findListOption('add', 'raid');
  const editRaid = findListOption('edit', 'raid');

  assert.equal(addRaid.autocomplete, true);
  assert.equal(addRaid.max_length, 100);
  assert.equal(addRaid.choices, undefined);
  assert.equal(editRaid.autocomplete, undefined);
  assert.deepEqual(
    editRaid.choices.map(({ name, value }) => ({ name, value })),
    getRaidChoices(),
  );
});

test('watchlist raid autocomplete offers the typed custom label plus canonical matches', () => {
  assert.deepEqual(getRaidAutocompleteChoices('Secra', { allowCustom: true }), [
    { name: 'Custom · Secra', value: 'Secra' },
    { name: 'Secra Nor', value: 'Secra Nor' },
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

test('la-list autocomplete route exposes a custom raid only for add type:watch', async () => {
  const route = createAutocompleteRoutes()['la-list'];
  const responses = [];
  const interaction = {
    options: {
      getFocused: () => ({ name: 'raid', value: 'Event Gate' }),
      getSubcommand: () => 'add',
      getString: () => 'watch',
    },
    respond: async (choices) => responses.push(choices),
  };

  await route(interaction);
  assert.deepEqual(responses[0], [{ name: 'Custom · Event Gate', value: 'Event Gate' }]);

  interaction.options.getString = () => 'black';
  await route(interaction);
  assert.deepEqual(responses[1], []);
});
