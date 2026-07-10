import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  TRANSLATIONS,
} from '../bot/locales/index.js';
import rawEn from '../bot/locales/en.js';
import rawVi from '../bot/locales/vi.js';
import rawJp from '../bot/locales/jp.js';
import {
  clearGuildLanguageCache,
  clearUserLanguageCache,
  getCachedUserLanguage,
  getGuildLanguage,
  getSupportedLanguages,
  getUserLanguage,
  normalizeLanguage,
  resolveLocale,
  setGuildLanguage,
  setUserLanguage,
  t,
} from '../bot/services/i18n/index.js';
import { buildCommands, buildOwnerCommands } from '../bot/commands/index.js';
import {
  buildLanguageDropdown,
  buildLanguageEmbed,
  LANGUAGE_SWITCH_SELECT_CUSTOM_ID,
} from '../bot/handlers/meta/languageSwitch.js';

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

test('LoaLogs locale supports en, vi, and jp with English default', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en');
  assert.deepEqual(getSupportedLanguages(), SUPPORTED_LANGUAGES);
  assert.deepEqual(SUPPORTED_LANGUAGES.map((entry) => entry.code), ['en', 'vi', 'jp']);
  assert.deepEqual(Object.keys(TRANSLATIONS), ['en', 'vi', 'jp']);

  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('vi'), 'vi');
  assert.equal(normalizeLanguage('jp'), 'jp');
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('vi'), 'vi');
  assert.equal(resolveLocale('jp'), 'jp');
  assert.equal(normalizeLanguage('vn'), 'en');
});

test('t resolves nested strings, arrays, objects, and fallback keys', () => {
  assert.equal(t('commands.status.description'), 'Show live server status');
  assert.equal(t('languageSwitch.title', 'vi'), '🌐 Đổi ngôn ngữ Artist');
  assert.equal(t('languageSwitch.title', 'jp'), '🌐 Artist の言語を変更');
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

test('locale packs keep the same concrete leaf-key shape', () => {
  const expected = new Set(leafKeys(TRANSLATIONS.en));
  for (const [code, tree] of Object.entries(TRANSLATIONS)) {
    const actual = new Set(leafKeys(tree));
    const missing = [...expected].filter((key) => !actual.has(key));
    assert.deepEqual(missing, [], `${code} is missing locale keys`);
    assert.equal([...actual].some((key) => key.includes('undefined')), false);
  }
});

test('raw locale packs are complete without relying on English fallback', () => {
  const expected = new Set(leafKeys(rawEn));
  for (const [code, tree] of Object.entries({ vi: rawVi, jp: rawJp })) {
    const actual = new Set(leafKeys(tree));
    const missing = [...expected].filter((key) => !actual.has(key));
    assert.deepEqual(missing, [], `${code} is relying on English fallback`);
  }
});

test('slash command metadata is sourced from locale and exposes all supported help languages', () => {
  const commands = buildCommands();
  const ownerCommands = buildOwnerCommands();
  const help = commands.find((command) => command.name === 'la-help');
  const languageSwitch = commands.find((command) => command.name === 'la-language-switch');
  const langOption = help.options.find((option) => option.name === 'lang');

  assert.equal(commands.find((command) => command.name === 'la-status').description, t('commands.status.description'));
  assert.equal(languageSwitch.description, t('commands.languageSwitch.description'));
  assert.deepEqual(
    langOption.choices.map(({ name, value }) => ({ name, value })),
    [
      { name: 'English', value: 'en' },
      { name: 'Tiếng Việt', value: 'vi' },
      { name: '日本語', value: 'jp' },
    ]
  );

  for (const description of [...commands, ...ownerCommands].flatMap((command) => walkCommandDescriptions(command))) {
    assert.ok(description.length <= 100, `Discord description is too long: ${description}`);
    assert.equal(description.startsWith('commands.'), false, `Unresolved i18n key: ${description}`);
  }
});

test('user language helpers normalize and cache through the UserPreference model boundary', async () => {
  clearUserLanguageCache();
  let findCount = 0;
  const updates = [];
  const UserPreferenceModel = {
    findOne() {
      findCount += 1;
      return {
        lean: async () => ({ language: 'jp' }),
      };
    },
    updateOne: async (...args) => {
      updates.push(args);
    },
  };

  assert.equal(getCachedUserLanguage('user-1'), 'en');
  assert.equal(await getUserLanguage('user-1', { UserPreferenceModel }), 'jp');
  assert.equal(getCachedUserLanguage('user-1'), 'jp');
  assert.equal(await getUserLanguage('user-1', { UserPreferenceModel }), 'jp');
  assert.equal(findCount, 1);

  assert.equal(await setUserLanguage('user-1', 'vi', {
    UserPreferenceModel,
    user: { username: 'senko', globalName: 'Senko', displayName: 'Senko Bot' },
  }), 'vi');
  assert.equal(getCachedUserLanguage('user-1'), 'vi');
  assert.deepEqual(updates[0][1], {
    $set: {
      language: 'vi',
      discordUsername: 'senko',
      discordGlobalName: 'Senko',
      discordDisplayName: 'Senko Bot',
    },
    $setOnInsert: { discordId: 'user-1' },
  });
});

test('language switch UI mirrors the RaidManage dropdown flow', () => {
  const embed = buildLanguageEmbed('vi').toJSON();
  const dropdown = buildLanguageDropdown('vi').toJSON().components[0];

  assert.equal(embed.title, t('languageSwitch.title', 'vi'));
  assert.match(embed.description, /Tiếng Việt/);
  assert.equal(dropdown.custom_id, LANGUAGE_SWITCH_SELECT_CUSTOM_ID);
  assert.equal(dropdown.options.length, 3);
  assert.deepEqual(
    dropdown.options.map(({ value, default: isDefault }) => ({ value, isDefault })),
    [
      { value: 'en', isDefault: false },
      { value: 'vi', isDefault: true },
      { value: 'jp', isDefault: false },
    ]
  );
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
  assert.equal(await setGuildLanguage('guild-1', 'jp', { GuildConfigModel }), 'jp');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0][1], {
    $set: { language: 'jp' },
    $setOnInsert: { guildId: 'guild-1' },
  });
});
