import test from 'node:test';
import assert from 'node:assert/strict';

import { buildListPageEmbed } from '../bot/handlers/list/view/ui.js';

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
