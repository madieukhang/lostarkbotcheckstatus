import test from 'node:test';
import assert from 'node:assert/strict';

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

test('/la-list view caches refreshed evidence URLs within the view session', async () => {
  let refreshCalls = 0;
  const evidenceUrlCache = new Map();
  const options = {
    allEntries: [buildEntry()],
    client: { id: 'client' },
    currentType: 'black',
    evidenceUrlCache,
    getListContext,
    guildNameCache: new Map(),
    isOwnerGuild: false,
    itemsPerPage: 10,
    page: 0,
    refreshImageUrlFn: async (messageId, channelId, client) => {
      refreshCalls += 1;
      assert.equal(messageId, 'message-1');
      assert.equal(channelId, 'channel-1');
      assert.equal(client.id, 'client');
      return 'https://cdn.example/fresh.png';
    },
    totalPages: 1,
  };

  const firstEmbed = await buildListPageEmbed(options);
  const secondEmbed = await buildListPageEmbed(options);

  assert.equal(refreshCalls, 1);
  assert.match(firstEmbed.toJSON().description, /https:\/\/cdn\.example\/fresh\.png/);
  assert.match(secondEmbed.toJSON().description, /https:\/\/cdn\.example\/fresh\.png/);
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

  const evidenceSelect = rows[1].toJSON().components[0];
  assert.match(evidenceSelect.placeholder, /Xem evidence của/);

  const expiredPager = buildExpiredComponents('jp')[0].toJSON().components;
  assert.equal(expiredPager[0].label, '前へ');
  assert.equal(expiredPager[2].label, '次へ');
  assert.match(expiredPager[1].label, /\/la-list view/);
});
