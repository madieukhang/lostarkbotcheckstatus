import test from 'node:test';
import assert from 'node:assert/strict';

import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { loadListViewStatMap } from '../bot/handlers/list/view/pageData.js';
import {
  buildExpiredComponents,
  buildListPageEmbed,
  buildListViewComponents,
  buildTrustedListEmbed,
} from '../bot/handlers/list/view/ui.js';

const getListContext = () => ({
  label: 'blacklist',
  color: 0xed4245,
  icon: 'x',
});

function buildEntry(overrides = {}) {
  return {
    name: 'Testchar',
    reason: 'evidence attached',
    addedAt: new Date('2026-05-22T00:00:00Z'),
    imageChannelId: 'channel-1',
    imageMessageId: 'message-1',
    _icon: 'x',
    _label: 'Blacklist',
    _color: 0xed4245,
    ...overrides,
  };
}

test('/la-list view loads one compact stat map before the pure renderer runs', async () => {
  let snapshotCalls = 0;
  const entry = buildEntry({
    allCharacters: ['Testchar', 'Altchar'],
    imageUrl: 'https://cdn.example/evidence.png',
  });
  const options = {
    allEntries: [entry],
    currentType: 'black',
    getListContext,
    guildNameCache: new Map(),
    isOwnerGuild: false,
    itemsPerPage: 10,
    page: 0,
    totalPages: 1,
  };
  const statMap = await loadListViewStatMap({
    RosterSnapshotModel: {
      find(query, projection) {
        snapshotCalls += 1;
        assert.deepEqual(query, {});
        assert.equal(projection._id, 0);
        assert.equal(projection.name, 1);
        assert.equal(projection.classId, 1);
        return {
          async lean() {
            return [
              { name: 'Testchar', classId: 'bard' },
              { name: 'Altchar', classId: 'reaper' },
            ];
          },
        };
      },
    },
  });
  options.statMap = statMap;

  assert.equal(snapshotCalls, 1);

  const previousEmoji = {
    Bard: CLASS_EMOJI_MAP.Bard,
    Reaper: CLASS_EMOJI_MAP.Reaper,
  };
  Object.assign(CLASS_EMOJI_MAP, {
    Bard: '<:bard:101>',
    Reaper: '<:reaper:102>',
  });
  try {
    const embed = buildListPageEmbed(options);
    const description = embed.toJSON().description;

    assert.match(description, /^` 1`/u);
    assert.doesNotMatch(description, /cdn\.example/u);
    assert.doesNotMatch(description, /^Page /u);
    assert.match(description, /<:bard:101> \*\*\[Testchar\]/u);
    assert.match(description, /<:reaper:102> \[Altchar\]/u);
  } finally {
    Object.assign(CLASS_EMOJI_MAP, previousEmoji);
  }
});

test('/la-list view keeps every entry whole when rich class and alt markup reaches the embed cap', () => {
  const previousEmoji = CLASS_EMOJI_MAP.Bard;
  CLASS_EMOJI_MAP.Bard = '<:bard_abcdef:123456789012345678>';
  try {
    const statMap = new Map();
    const allEntries = Array.from({ length: 10 }, (_, index) => {
      const suffix = String(index + 1).padStart(2, '0');
      const name = `Character${suffix}Longname`;
      const alts = Array.from({ length: 8 }, (_, altIndex) => `Alt${suffix}${altIndex}Longcharacter`);
      for (const characterName of [name, ...alts]) {
        statMap.set(characterName.toLowerCase(), { name: characterName, classId: 'bard' });
      }
      return buildEntry({
        name,
        allCharacters: [name, ...alts],
        reason: 'x'.repeat(80),
      });
    });
    const description = buildListPageEmbed({
      allEntries,
      currentType: 'black',
      getListContext,
      guildNameCache: new Map(),
      isOwnerGuild: false,
      itemsPerPage: 10,
      page: 0,
      statMap,
    }).toJSON().description;

    assert.ok(description.length <= 4096);
    assert.match(description, /Character10Longname/u);
    assert.doesNotMatch(description, /<:[^>\n]*$/u);
  } finally {
    CLASS_EMOJI_MAP.Bard = previousEmoji;
  }
});

test('/la-list view renders localized pagination and evidence controls', () => {
  const rows = buildListViewComponents({
    allEntries: [buildEntry()],
    itemsPerPage: 10,
    lang: 'vi',
    page: 0,
    totalPages: 2,
  });

  const pager = rows[0].toJSON().components;
  assert.equal(pager[0].label, 'Trước');
  assert.equal(pager[2].label, 'Tiếp');
  assert.equal(pager[3].label, 'Làm mới');
  assert.equal(pager[3].custom_id, 'listview_refresh');

  const evidenceSelect = rows[1].toJSON().components[0];
  assert.match(evidenceSelect.placeholder, /Xem evidence của/);

  const expiredPager = buildExpiredComponents('jp')[0].toJSON().components;
  assert.equal(expiredPager[0].label, '前へ');
  assert.equal(expiredPager[2].label, '次へ');
  assert.match(expiredPager[1].label, /\/la-list view/);
});

test('/la-list view shows list markers only where rows from different lists are mixed', () => {
  const entry = buildEntry({ _icon: '⛔' });
  const baseOptions = {
    allEntries: [entry],
    getListContext,
    guildNameCache: new Map(),
    isOwnerGuild: false,
    itemsPerPage: 10,
    page: 0,
  };

  const typedDescription = buildListPageEmbed({
    ...baseOptions,
    currentType: 'black',
  }).toJSON().description;
  const mixedDescription = buildListPageEmbed({
    ...baseOptions,
    currentType: 'all',
  }).toJSON().description;
  const trustedDescription = buildTrustedListEmbed([entry], 'en').toJSON().description;

  assert.doesNotMatch(typedDescription, /⛔/u);
  assert.match(mixedDescription, /^` 1` ⛔ /u);
  assert.doesNotMatch(trustedDescription, /🛡️/u);
});

test('/la-list view evidence values keep their absolute index without page scans', () => {
  const allEntries = [
    buildEntry({ name: 'No image', imageMessageId: null }),
    buildEntry({ name: 'First image', imageUrl: 'https://cdn.example/first.png' }),
    buildEntry({ name: 'No image 2', imageMessageId: null }),
    buildEntry({ name: 'Second image', imageMessageId: 'message-2' }),
  ];
  const rows = buildListViewComponents({
    allEntries,
    itemsPerPage: 10,
    lang: 'en',
    page: 0,
    totalPages: 1,
  });

  const options = rows[1].toJSON().components[0].options;
  assert.deepEqual(options.map((option) => option.value), ['1', '3']);
});
