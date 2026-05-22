import test from 'node:test';
import assert from 'node:assert/strict';

import { createViewHandlers } from '../bot/handlers/list/view/index.js';

test('/la-list view rejects DM usage with an ephemeral alert', async () => {
  const calls = [];
  const interaction = {
    guild: null,
    user: { id: 'viewer-1' },
    options: {
      getString: () => {
        throw new Error('options should not be read before guild check');
      },
    },
    reply: async (payload) => calls.push(payload),
  };

  const { handleListViewCommand } = createViewHandlers({ client: {} });
  await handleListViewCommand(interaction);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].ephemeral, true);
  assert.equal(calls[0].embeds.length, 1);
});
