import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommands } from '../bot/commands/index.js';

function listSubcommandOptions(subcommandName) {
  const list = buildCommands().find((command) => command.name === 'la-list');
  const subcommand = list.options.find((option) => option.name === subcommandName);
  return subcommand.options.map((option) => option.name);
}

test('/la-list add and /la-list edit take no logs link', () => {
  for (const subcommandName of ['add', 'edit']) {
    const options = listSubcommandOptions(subcommandName);
    assert.ok(options.includes('reason') || options.includes('name'), `${subcommandName}: ${options.join(', ')}`);
    assert.ok(!options.includes('logs'), `${subcommandName} still offers logs: ${options.join(', ')}`);
  }
});
