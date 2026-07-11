import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCommands } from '../bot/commands/index.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import { startReadyBackgroundServices } from '../bot/app/lifecycle.js';

test('/la-setup collapses into a single config subcommand with the action option', () => {
  const setup = buildCommands().find((command) => command.name === 'la-setup');
  assert.ok(setup);

  const subs = setup.options.filter((option) => option.type === 1); // SUB_COMMAND
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, 'config');

  const opts = Object.fromEntries(subs[0].options.map((option) => [option.name, option]));
  assert.ok(opts.action, 'action option present');
  assert.equal(opts.action.autocomplete, true);
  assert.equal(opts.action.required, true);
  assert.ok(opts.channel, 'channel option present');
  assert.ok(opts.language, 'language option present');
  assert.ok(opts.scope, 'scope option present');
  assert.deepEqual(opts.scope.choices.map((choice) => choice.value), ['global', 'server']);
});

test('/la-setup dispatch maps every action to a handler', async () => {
  const { SETUP_ACTION_HANDLERS } = await import('../bot/handlers/setup/guildSetup.js');
  assert.deepEqual(Object.keys(SETUP_ACTION_HANDLERS).sort(), [
    'cleanup-off', 'cleanup-on', 'notify-off', 'notify-on', 'repin',
    'set-auto-channel', 'set-default-scope', 'set-language', 'set-notify-channel', 'show',
  ]);
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
