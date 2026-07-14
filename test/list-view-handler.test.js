import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import {
  createViewHandlers,
  loadListEntries,
} from '../bot/handlers/list/view/index.js';

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
