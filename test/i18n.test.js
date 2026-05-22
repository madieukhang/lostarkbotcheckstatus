import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  TRANSLATIONS,
} from '../bot/locales/index.js';
import {
  clearGuildLanguageCache,
  getGuildLanguage,
  getSupportedLanguages,
  normalizeLanguage,
  resolveLocale,
  setGuildLanguage,
  t,
} from '../bot/services/i18n/index.js';
import { buildCommands, buildOwnerCommands } from '../bot/commands/index.js';

function leafKeys(value, prefix = '', out = []) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      leafKeys(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.push(prefix);
  return out;
}

function walkCommandDescriptions(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.description === 'string') out.push(node.description);
  for (const option of node.options || []) {
    walkCommandDescriptions(option, out);
  }
  return out;
}

test('LoaLogs locale starts English-only', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  assert.deepEqual(getSupportedLanguages(), SUPPORTED_LANGUAGES);
  assert.deepEqual(SUPPORTED_LANGUAGES.map((entry) => entry.code), ['en']);
  assert.deepEqual(Object.keys(TRANSLATIONS), ['en']);

  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(normalizeLanguage('vn'), 'en');
  assert.equal(resolveLocale('jp'), 'en');
});

test('t resolves nested strings, arrays, objects, and fallback keys', () => {
  assert.equal(t('commands.status.description'), 'Show live server status');
  assert.deepEqual(t('help.sections.multiadd.fields.0.value').slice(0, 2), [
    '**1.** `/la-list multiadd action:template` -> Bot sends a blank template file',
    '**2.** Open in Excel, delete the yellow example row, fill in up to 30 rows',
  ]);
  assert.equal(
    t('help.sections.multiadd.fields.0').name,
    'How to use (4 steps)'
  );
  assert.equal(t('missing.key'), 'missing.key');
});

test('EN locale has concrete leaf keys only', () => {
  const keys = leafKeys(TRANSLATIONS.en);
  assert.ok(keys.includes('commands.help.options.lang'));
  assert.ok(keys.includes('help.overview.title'));
  assert.equal(keys.some((key) => key.includes('undefined')), false);
});

test('slash command metadata is sourced from locale and exposes only English help language', () => {
  const commands = buildCommands();
  const ownerCommands = buildOwnerCommands();
  const help = commands.find((command) => command.name === 'la-help');
  const langOption = help.options.find((option) => option.name === 'lang');

  assert.equal(commands.find((command) => command.name === 'la-status').description, t('commands.status.description'));
  assert.deepEqual(
    langOption.choices.map(({ name, value }) => ({ name, value })),
    [{ name: 'English', value: 'en' }]
  );

  for (const description of [...commands, ...ownerCommands].flatMap((command) => walkCommandDescriptions(command))) {
    assert.ok(description.length <= 100, `Discord description is too long: ${description}`);
    assert.equal(description.startsWith('commands.'), false, `Unresolved i18n key: ${description}`);
  }
});

test('guild language helpers normalize and cache through the GuildConfig model boundary', async () => {
  clearGuildLanguageCache();
  const updates = [];
  const GuildConfigModel = {
    findOne() {
      return {
        lean: async () => ({ language: 'vn' }),
      };
    },
    updateOne: async (...args) => {
      updates.push(args);
    },
  };

  assert.equal(await getGuildLanguage('guild-1', { GuildConfigModel }), 'en');
  assert.equal(await setGuildLanguage('guild-1', 'jp', { GuildConfigModel }), 'en');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0][1], {
    $set: { language: 'en' },
    $setOnInsert: { guildId: 'guild-1' },
  });
});
