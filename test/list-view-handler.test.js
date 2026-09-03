import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import {
  buildBlacklistViewQuery,
  createViewHandlers,
  loadListEntries,
} from '../bot/handlers/list/view/index.js';

test('blacklist view scope query uses the first matching policy rule', () => {
  assert.deepEqual(
    buildBlacklistViewQuery({ isOwnerGuild: true, scopeFilter: 'all', viewGuildId: 'g1' }),
    {}
  );
  assert.deepEqual(
    buildBlacklistViewQuery({ isOwnerGuild: false, scopeFilter: 'global', viewGuildId: 'g1' }),
    { $or: [{ scope: 'global' }, { scope: { $exists: false } }] }
  );
  assert.deepEqual(
    buildBlacklistViewQuery({ isOwnerGuild: true, scopeFilter: 'server', viewGuildId: 'g1' }),
    { scope: 'server' }
  );
  assert.deepEqual(
    buildBlacklistViewQuery({ isOwnerGuild: false, scopeFilter: 'server', viewGuildId: 'g1' }),
    { scope: 'server', guildId: 'g1' }
  );
});

test('/la-list view acknowledges before rejecting DM usage with an ephemeral alert', async () => {
  const calls = [];
  const interaction = {
    guild: null,
    user: { id: 'viewer-1' },
    options: {
      getString: () => {
        throw new Error('options should not be read before guild check');
      },
    },
    deferReply: async (payload) => calls.push({ method: 'deferReply', payload }),
    editReply: async (payload) => calls.push({ method: 'editReply', payload }),
  };

  const { handleListViewCommand } = createViewHandlers({ client: {} });
  await handleListViewCommand(interaction);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'deferReply');
  assert.equal(calls[0].payload.flags, MessageFlags.Ephemeral);
  assert.equal(calls[1].method, 'editReply');
  assert.equal(calls[1].payload.embeds.length, 1);
});

test('/la-list view loads all list collections concurrently and keeps global recency order', async () => {
  const rowsByType = {
    black: [{ name: 'Black', addedAt: new Date('2026-01-01T00:00:00Z') }],
    white: [{ name: 'White', addedAt: new Date('2026-03-01T00:00:00Z') }],
    watch: [{ name: 'Watch', addedAt: new Date('2026-02-01T00:00:00Z') }],
  };
  let activeQueries = 0;
  let maxActiveQueries = 0;

  const resolveListContext = (listType) => ({
    label: `${listType}-label`,
    color: `${listType}-color`,
    icon: `${listType}-icon`,
    model: {
      find() {
        return {
          sort() {
            return {
              async lean() {
                activeQueries += 1;
                maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
                await new Promise((resolve) => setImmediate(resolve));
                activeQueries -= 1;
                return rowsByType[listType];
              },
            };
          },
        };
      },
    },
  });

  const entries = await loadListEntries({
    isOwnerGuild: true,
    scopeFilter: '',
    type: 'all',
    viewGuildId: 'guild-1',
  }, { resolveListContext });

  assert.equal(maxActiveQueries, 3);
  assert.deepEqual(entries.map((entry) => entry.name), ['White', 'Watch', 'Black']);
  assert.deepEqual(entries.map((entry) => entry._listType), ['white', 'watch', 'black']);
  assert.equal(entries[0]._label, 'white-label');
});

test('/la-list view reuses its session snapshot for pagination and reloads only on refresh', async () => {
  let loadCalls = 0;
  let fetchReplyCalls = 0;
  let collectHandler = null;
  const messageEdits = [];
  const buildRows = (count) => Array.from({ length: count }, (_, index) => ({
    name: `Blocked${index + 1}`,
    reason: 'test',
    addedAt: new Date(2026, 0, count - index),
    _listType: 'black',
    _label: 'Blacklist',
    _color: 0xed4245,
    _icon: '⛔',
  }));
  let currentRows = buildRows(11);
  const replyMessage = {
    createMessageComponentCollector() {
      return {
        on(event, handler) {
          if (event === 'collect') collectHandler = handler;
          return this;
        },
      };
    },
  };
  const interaction = {
    guild: { id: 'guild-live-view' },
    user: { id: 'viewer-live' },
    options: {
      getString: (name) => (name === 'type' ? 'black' : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      messageEdits.push(payload);
      return replyMessage;
    },
    fetchReply: async () => {
      fetchReplyCalls += 1;
      return replyMessage;
    },
  };
  const { handleListViewCommand } = createViewHandlers({
    client: { guilds: { fetch: async () => ({ name: 'Guild' }) } },
    connectDatabase: async () => {},
    loadEntries: async () => {
      loadCalls += 1;
      return currentRows;
    },
    hydratePage: async () => ({}),
    getLanguage: async () => 'en',
  });

  await handleListViewCommand(interaction);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchReplyCalls, 0);
  assert.equal(loadCalls, 1);

  const click = async (customId) => collectHandler({
    customId,
    user: { id: 'viewer-live' },
    deferUpdate: async () => {},
  });

  await click('listview_next');
  assert.equal(loadCalls, 1, 'recent navigation should reuse the session snapshot');

  currentRows = buildRows(12);
  await click('listview_prev');
  assert.equal(loadCalls, 1, 'pagination should not turn into an implicit full-list query');
  assert.match(messageEdits.at(-1).embeds[0].toJSON().title, /11 entries/);

  currentRows = buildRows(13);
  await click('listview_refresh');
  assert.equal(loadCalls, 2, 'the refresh button should explicitly reload the list');
  assert.match(messageEdits.at(-1).embeds[0].toJSON().title, /13 entries/);
});

test('/la-list view renders before slow evidence and class hydration completes', async () => {
  let collectHandler = null;
  let releaseHydration;
  let hydrationStarted = false;
  const messageEdits = [];
  const hydrationGate = new Promise((resolve) => {
    releaseHydration = resolve;
  });
  const replyMessage = {
    createMessageComponentCollector() {
      return {
        on(event, handler) {
          if (event === 'collect') collectHandler = handler;
          return this;
        },
      };
    },
  };
  const interaction = {
    guild: { id: 'guild-first-render' },
    user: { id: 'viewer-first-render' },
    options: {
      getString: (name) => (name === 'type' ? 'black' : null),
    },
    deferReply: async () => {},
    editReply: async (payload) => {
      messageEdits.push(payload);
      return replyMessage;
    },
  };
  const { handleListViewCommand } = createViewHandlers({
    client: { guilds: { cache: new Map() } },
    connectDatabase: async () => {},
    getLanguage: async () => 'en',
    hydratePage: async () => {
      hydrationStarted = true;
      await hydrationGate;
      return { evidenceCount: 1, snapshotCount: 1 };
    },
    loadEntries: async () => [{
      name: 'Fastfirst',
      reason: 'test',
      addedAt: new Date('2026-01-01T00:00:00Z'),
      _listType: 'black',
      _label: 'Blacklist',
      _color: 0xed4245,
      _icon: '⛔',
    }],
  });

  await handleListViewCommand(interaction);

  assert.equal(hydrationStarted, true);
  assert.equal(messageEdits.length, 1, 'the initial page should not wait for background hydration');
  assert.equal(typeof collectHandler, 'function');

  releaseHydration();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageEdits.length, 2, 'hydrated decorations should update the visible page once');
});
