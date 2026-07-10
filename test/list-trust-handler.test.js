import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';

import { createTrustHandlers } from '../bot/handlers/list/trust/index.js';

test('/la-list trust rejects non-officers with an ephemeral alert', async () => {
  const calls = [];
  const interaction = {
    user: { id: 'not-an-officer', tag: 'NotOfficer#0001' },
    options: {
      getString: () => {
        throw new Error('options should not be read before auth passes');
      },
    },
    reply: async (payload) => calls.push(payload),
  };

  const { handleListTrustCommand } = createTrustHandlers();
  await handleListTrustCommand(interaction);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].flags, MessageFlags.Ephemeral);
  assert.equal(calls[0].embeds.length, 1);
});
