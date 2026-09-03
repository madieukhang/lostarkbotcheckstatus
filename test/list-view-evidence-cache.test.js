import test from 'node:test';
import assert from 'node:assert/strict';

import { CLASS_EMOJI_MAP } from '../bot/models/Class.js';
import { hydrateListViewPage } from '../bot/handlers/list/view/pageData.js';
import {
  buildExpiredComponents,
  buildListPageEmbed,
  buildListViewComponents,
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

test('/la-list view hydrates evidence and class caches once, outside the pure renderer', async () => {
  let refreshCalls = 0;
  let snapshotCalls = 0;
  const evidenceUrlCache = new Map();
  const loadedSnapshotNames = new Set();
  const statMap = new Map();
  const entry = buildEntry({ allCharacters: ['Testchar', 'Altchar'] });
  const options = {
    allEntries: [entry],
    currentType: 'black',
    evidenceUrlCache,
    getListContext,
    guildNameCache: new Map(),
    isOwnerGuild: false,
    itemsPerPage: 10,
    page: 0,
    statMap,
    totalPages: 1,
  };
  const hydrateOptions = {
    client: { id: 'client' },
    entries: [entry],
    evidenceUrlCache,
    loadedSnapshotNames,
    statMap,
    refreshImageUrlFn: async (messageId, channelId, client) => {
      refreshCalls += 1;
      assert.equal(messageId, 'message-1');
      assert.equal(channelId, 'channel-1');
      assert.equal(client.id, 'client');
      return 'https://cdn.example/fresh.png';
    },
    RosterSnapshotModel: {
      find({ name }) {
        snapshotCalls += 1;
        assert.deepEqual(new Set(name.$in), new Set(['Testchar', 'Altchar']));
        return {
          collation() { return this; },
          async lean() {
            return [
              { name: 'Testchar', classId: 'bard' },
              { name: 'Altchar', classId: 'reaper' },
            ];
          },
        };
      },
    },
  };

  const coldEmbed = buildListPageEmbed(options);
  assert.doesNotMatch(coldEmbed.toJSON().description, /cdn\.example/u);

  const previousEmoji = {
    Bard: CLASS_EMOJI_MAP.Bard,
    Reaper: CLASS_EMOJI_MAP.Reaper,
  };
  Object.assign(CLASS_EMOJI_MAP, {
    Bard: '<:bard:101>',
    Reaper: '<:reaper:102>',
  });
  try {
    await hydrateListViewPage(hydrateOptions);
    const firstEmbed = buildListPageEmbed(options);
    await hydrateListViewPage(hydrateOptions);
    const secondEmbed = buildListPageEmbed(options);

    assert.equal(refreshCalls, 1);
    assert.equal(snapshotCalls, 1);
    assert.match(firstEmbed.toJSON().description, /https:\/\/cdn\.example\/fresh\.png/);
    assert.match(firstEmbed.toJSON().description, /<:bard:101> \*\*\[Testchar\]/u);
    assert.match(firstEmbed.toJSON().description, /<:reaper:102> \[Altchar\]/u);
    assert.match(secondEmbed.toJSON().description, /https:\/\/cdn\.example\/fresh\.png/);
  } finally {
    Object.assign(CLASS_EMOJI_MAP, previousEmoji);
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

test('/la-list view drops a stale legacy evidence URL after refresh confirms it is unavailable', async () => {
  const entry = buildEntry({ imageUrl: 'https://cdn.example/stale.png' });
  const evidenceUrlCache = new Map();
  const options = {
    allEntries: [entry],
    currentType: 'black',
    evidenceUrlCache,
    getListContext,
    guildNameCache: new Map(),
    isOwnerGuild: false,
    itemsPerPage: 10,
    page: 0,
    totalPages: 1,
  };

  assert.match(buildListPageEmbed(options).toJSON().description, /stale\.png/u);

  await hydrateListViewPage({
    client: {},
    entries: [entry],
    evidenceUrlCache,
    loadedSnapshotNames: new Set(),
    refreshImageUrlFn: async () => '',
    RosterSnapshotModel: {
      find() {
        return {
          collation() { return this; },
          async lean() { return []; },
        };
      },
    },
    statMap: new Map(),
  });

  assert.doesNotMatch(buildListPageEmbed(options).toJSON().description, /stale\.png/u);
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
