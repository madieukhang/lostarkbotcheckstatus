import test from 'node:test';
import assert from 'node:assert/strict';

import { createLongRunningReplyEditor } from '../bot/utils/longRunningReply.js';

test('long-running reply editor switches from webhook edit to message edit', async () => {
  const messageEdits = [];
  const message = {
    id: 'reply-1',
    edit: async (payload) => {
      messageEdits.push(payload);
      return message;
    },
  };
  const interaction = {
    editReplyCalls: 0,
    editReply: async () => {
      interaction.editReplyCalls += 1;
      return { id: 'reply-1' };
    },
    channel: {
      messages: {
        fetch: async (id) => {
          assert.equal(id, 'reply-1');
          return message;
        },
      },
    },
  };

  const editor = createLongRunningReplyEditor(interaction);

  await editor.edit({ content: 'first' });
  await editor.edit({ content: 'second' });

  assert.equal(interaction.editReplyCalls, 1);
  assert.deepEqual(messageEdits, [{ content: 'second' }]);
  assert.equal(editor.getMessage(), message);
});

test('long-running reply editor uses an existing component message directly', async () => {
  const messageEdits = [];
  const message = {
    edit: async (payload) => {
      messageEdits.push(payload);
      return message;
    },
  };
  const interaction = {
    message,
    editReply: async () => {
      throw new Error('unexpected webhook edit');
    },
  };

  const editor = createLongRunningReplyEditor(interaction);
  await editor.edit({ content: 'updated' });

  assert.deepEqual(messageEdits, [{ content: 'updated' }]);
});
