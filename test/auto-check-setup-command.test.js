import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCommands } from '../bot/commands/index.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import { startReadyBackgroundServices } from '../bot/app/lifecycle.js';

test('/la-setup exposes repin and guild-language controls', () => {
  const setup = buildCommands().find((command) => command.name === 'la-setup');
  assert.ok(setup);

  const byName = new Map(setup.options.map((option) => [option.name, option]));
  assert.ok(byName.has('repin'));
  assert.ok(byName.has('language'));

  const languageOption = byName.get('language').options.find(
    (option) => option.name === 'language'
  );
  assert.deepEqual(
    languageOption.choices.map((choice) => choice.value),
    ['en', 'vi', 'jp']
  );
});

test('GuildConfig tracks the welcome pin and daily cleanup cursor', () => {
  assert.ok(GuildConfig.schema.path('autoCheckWelcomeMessageId'));
  assert.ok(GuildConfig.schema.path('autoCheckWelcomeChannelId'));
  assert.ok(GuildConfig.schema.path('lastAutoCheckCleanupKey'));
});

test('ready background services include the daily auto-check cleanup scheduler', () => {
  const calls = [];
  const client = { id: 'client' };

  startReadyBackgroundServices(client, {
    startMonitorFn: (value) => calls.push(['monitor', value]),
    setupAutoCheckFn: (value) => calls.push(['auto-check', value]),
    startAutoCheckCleanupFn: (value) => calls.push(['cleanup', value]),
  });

  assert.deepEqual(calls, [
    ['monitor', client],
    ['auto-check', client],
    ['cleanup', client],
  ]);
});

test('/la-setup autochannel does not claim the cleanup day before cleanup runs', () => {
  const source = readFileSync(
    new URL('../bot/handlers/setup/guildSetup.js', import.meta.url),
    'utf8'
  );
  const start = source.indexOf('async function handleSetupAutoChannel');
  const end = source.indexOf('async function handleSetupNotifyChannel');
  const handlerSource = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(handlerSource, /lastAutoCheckCleanupKey|getVietnamDayKey/);
});
