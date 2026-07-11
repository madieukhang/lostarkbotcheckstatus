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
  assert.ok(byName.has('cleanup'));

  const cleanupState = byName.get('cleanup').options.find(
    (option) => option.name === 'state'
  );
  assert.deepEqual(
    cleanupState.choices.map((choice) => choice.value),
    ['on', 'off']
  );

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
  assert.equal(GuildConfig.schema.path('autoCheckCleanupEnabled').options.default, false);
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
  assert.doesNotMatch(handlerSource, /GuildConfig\.findOneAndUpdate/);
  assert.match(handlerSource, /configSet:\s*\{/);
  assert.match(handlerSource, /autoCheckCleanupEnabled:\s*cleanupEnabled/);
  assert.match(handlerSource, /cleanupEnabled,/);
  assert.match(handlerSource, /!welcome\.pinned\s*\|\|\s*!welcome\.persisted/);
});

test('/la-setup imports the Discord permission flags used by its guild guard', () => {
  const source = readFileSync(
    new URL('../bot/handlers/setup/guildSetup.js', import.meta.url),
    'utf8'
  );

  assert.match(
    source,
    /import\s*\{[^}]*\bPermissionFlagsBits\b[^}]*\}\s*from\s*['"]discord\.js['"]/
  );
  assert.match(source, /PermissionFlagsBits\.ManageGuild/);
});
