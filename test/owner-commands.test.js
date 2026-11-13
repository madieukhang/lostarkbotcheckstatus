import test from 'node:test';
import assert from 'node:assert/strict';

import { SUPPORTED_LANGUAGES } from '../bot/locales/index.js';
import { buildCommands, buildOwnerCommands } from '../bot/commands/index.js';
import { t } from '../bot/services/i18n/index.js';

test('/la-reset is registered and listed in help only for the owner server', () => {
  assert.equal(buildCommands().some(({ name }) => name === 'la-reset'), false);
  assert.equal(buildOwnerCommands().some(({ name }) => name === 'la-reset'), true);

  for (const { code } of SUPPORTED_LANGUAGES) {
    const publicLines = t('help.overview.groups', code).flatMap(({ lines }) => lines);
    const ownerLines = t('help.overview.ownerGroup', code).lines;
    assert.equal(publicLines.some((line) => line.includes('/la-reset')), false, `${code} public help`);
    assert.equal(ownerLines.some((line) => line.includes('/la-reset')), true, `${code} owner help`);
  }
});

test('/la-remote offers leave with server suggestions', () => {
  const remote = buildOwnerCommands().find(({ name }) => name === 'la-remote');
  const action = remote.options.find(({ name }) => name === 'action');
  const guild = remote.options.find(({ name }) => name === 'guild');
  assert.equal(action.choices.some(({ value }) => value === 'leave'), true);
  assert.equal(guild.autocomplete, true);

  for (const { code } of SUPPORTED_LANGUAGES) {
    const ownerLines = t('help.overview.ownerGroup', code).lines;
    assert.equal(ownerLines.some((line) => line.includes('action:leave')), true, `${code} owner help`);
  }
});
