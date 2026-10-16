import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client } from 'discord.js';
import { refreshImageUrl, refreshLegacyImageUrl, resolveDisplayImageUrl } from '../bot/utils/imageRehost.js';

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

const DISCORD_LINK = 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=1&is=2&hm=3';
const FRESH_LINK = 'https://cdn.discordapp.com/attachments/1/2/proof.png?ex=9';

// Every AbortSignal.timeout fires on the next tick, so a request that waits
// for its signal ends at once instead of after the real timeout.
function expireTimeoutsImmediately(t) {
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    const controller = new AbortController();
    setImmediate(() => controller.abort(new DOMException('timed out', 'TimeoutError')));
    return controller.signal;
  });
  return timeouts;
}

// Answers each request with the next entry of `responses`; a null entry never
// answers until the request's own signal aborts. Returns the signal of each
// request, for a caller that swallows the request's failure.
function mockDiscordRequests(t, ...responses) {
  let call = 0;
  const signals = [];
  t.mock.method(globalThis, 'fetch', (_url, init) => {
    signals.push(init.signal);
    assert.ok(init.signal, 'every Discord request carries a timeout signal');
    const response = responses[call++];
    if (response) return Promise.resolve(response);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  });
  return signals;
}

const refreshed = { ok: true, status: 200, json: async () => ({ refreshed_urls: [{ refreshed: FRESH_LINK }] }) };

test('a refresh request that never answers rejects with a timeout', async t => {
  const timeouts = expireTimeoutsImmediately(t);
  mockDiscordRequests(t, null);

  await assert.rejects(refreshLegacyImageUrl(DISCORD_LINK, { token: 'bot-token' }), { name: 'TimeoutError' });
  assert.equal(timeouts.length, 1);
});

test('a file check that never answers rejects with a timeout', async t => {
  const timeouts = expireTimeoutsImmediately(t);
  mockDiscordRequests(t, refreshed, null);

  await assert.rejects(refreshLegacyImageUrl(DISCORD_LINK, { token: 'bot-token' }), { name: 'TimeoutError' });
  assert.equal(timeouts.length, 2);
});

test('a stored link is still shown when Discord does not answer the refresh', async t => {
  expireTimeoutsImmediately(t);
  const signals = mockDiscordRequests(t, null);
  t.mock.method(console, 'warn', () => {});

  assert.equal(await resolveDisplayImageUrl({ imageUrl: DISCORD_LINK }, { token: 'bot-token' }), DISCORD_LINK);
  // The stored link comes back on any failure, so only the request itself
  // shows that it carried a signal.
  assert.equal(signals.length, 1);
  assert.ok(signals[0] instanceof AbortSignal, 'the refresh request carries a timeout signal');
});
