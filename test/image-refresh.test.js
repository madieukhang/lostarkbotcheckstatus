import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client } from 'discord.js';
import { refreshImageUrl } from '../bot/utils/imageRehost.js';

const evidenceMessage = (url) => ({
  id: '200', channel_id: '100', type: 0, content: '', timestamp: new Date().toISOString(),
  author: { id: '1', username: 'bot', discriminator: '0' },
  attachments: [{ id: '300', filename: 'evidence.png', size: 1, url, proxy_url: url }],
});

test('refreshImageUrl asks Discord for a newly signed URL even when the message is cached', async t => {
  const client = new Client({ intents: [] });
  t.after(() => client.destroy());
  const channel = client.channels._add({ id: '100', type: ChannelType.DM, recipients: [], last_message_id: null });
  channel.messages._add(evidenceMessage('https://cdn.test/expired'));
  let restCalls = 0;
  client.rest.get = async () => {
    restCalls += 1;
    return evidenceMessage('https://cdn.test/fresh');
  };

  assert.equal(await refreshImageUrl('200', '100', client), 'https://cdn.test/fresh');
  assert.equal(restCalls, 1);
  assert.equal(channel.messages.cache.get('200').attachments.first().url, 'https://cdn.test/expired');
});
