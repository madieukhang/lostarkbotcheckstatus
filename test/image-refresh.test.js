import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Client } from 'discord.js';
import {
  hasEvidence,
  probeArchiveImage,
  refreshImageUrl,
  refreshLegacyImageUrl,
  resolveDisplayImageUrl,
} from '../bot/utils/imageRehost.js';

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

// A client whose evidence channel is cached and whose REST reads answer with
// `answer` (a message object, or an error to throw).
function archiveClient(t, answer, { cacheChannel = true } = {}) {
  const client = new Client({ intents: [] });
  t.after(() => client.destroy());
  if (cacheChannel) client.channels._add({ id: '100', type: ChannelType.DM, recipients: [], last_message_id: null });
  client.rest.get = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return client;
}
const discordError = fields => Object.assign(new Error('Discord refused'), fields);

test('probeArchiveImage reports gone for unknown message, unknown channel and missing access', async t => {
  for (const [code, cacheChannel] of [[10008, true], [10003, false], [50001, true]]) {
    const client = archiveClient(t, discordError({ code }), { cacheChannel });
    assert.deepEqual(await probeArchiveImage('200', '100', client), { url: '', gone: true }, `code ${code}`);
  }
});

test('probeArchiveImage reports a server error as not gone', async t => {
  t.mock.method(console, 'warn', () => {});
  const client = archiveClient(t, discordError({ status: 500 }));
  assert.deepEqual(await probeArchiveImage('200', '100', client), { url: '', gone: false });
  assert.equal(await refreshImageUrl('200', '100', client), null);
});

test('a message without an attachment is gone', async t => {
  const client = archiveClient(t, { ...evidenceMessage('https://cdn.test/x'), attachments: [] });
  assert.deepEqual(await probeArchiveImage('200', '100', client), { url: '', gone: true });
});

test('probeArchiveImage returns the fresh link of a live archive message', async t => {
  const client = archiveClient(t, evidenceMessage('https://cdn.test/fresh'));
  assert.deepEqual(await probeArchiveImage('200', '100', client), { url: 'https://cdn.test/fresh', gone: false });
});

test('hasEvidence is true for each evidence field and false for none', () => {
  assert.equal(hasEvidence({ imageMessageId: 'm' }), true);
  assert.equal(hasEvidence({ imageUrl: 'https://x/y.png' }), true);
  assert.equal(hasEvidence({ imageSha256: 'abc' }), true);
  assert.equal(hasEvidence({ imageMessageId: '', imageUrl: '', imageSha256: '' }), false);
  assert.equal(hasEvidence(null), false);
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
