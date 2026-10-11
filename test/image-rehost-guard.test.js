import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import config from '../bot/config.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { rehostImage } from '../bot/utils/imageRehost.js';

// Multiadd rows carry member-typed image URLs, so the rehost download must
// never reach the bot's own network and must upload only images.
const PUBLIC_ADDRESS = [{ address: '93.184.215.14', family: 4 }];

function setup(t, { lookup = PUBLIC_ADDRESS, responses = [] } = {}) {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'rehost-guard-owner';
  t.after(() => { config.ownerGuildId = ownerGuildId; invalidateGuildConfig('rehost-guard-owner'); });
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ evidenceChannelId: 'evidence' }) }));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(dns.promises, 'lookup', async () => lookup);
  const fetched = [];
  // Like Node's fetch, a 3xx is followed inside fetch unless the caller asks
  // for manual redirects, so an unchecked hop shows up as a request here.
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    let current = String(url);
    for (;;) {
      fetched.push(current);
      const response = responses.shift() ?? assert.fail(`unexpected request to ${current}`);
      const location = response.headers.get('location');
      if (options.redirect === 'manual' || !location) return response;
      current = new URL(location, current).href;
    }
  });
  const uploads = [];
  const client = { channels: { fetch: async () => ({
    id: 'evidence',
    isTextBased: () => true,
    send: async payload => {
      uploads.push(payload);
      return { id: 'archived', attachments: { first: () => ({ url: 'https://cdn.discordapp.com/archived.png' }) } };
    },
  }) } };
  return { fetched, uploads, client };
}

const image = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
const redirectTo = location => new Response(null, { status: 302, headers: { location } });

test('a loopback, private or link-local address is refused before any request', async t => {
  const { fetched, uploads, client } = setup(t);
  for (const url of [
    'http://127.0.0.1:45678/internal-status',
    'http://10.0.0.5/a.png',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/a.png',
    'http://[::1]/a.png',
    'http://[fd12::1]/a.png',
    'http://[::ffff:127.0.0.1]/a.png',
    'http://[::127.0.0.1]/a.png',
    'http://[64:ff9b::7f00:1]/a.png',
    'http://[2002:7f00:1::1]/a.png',
    'http://[fec0::1]/a.png',
  ]) {
    assert.equal(await rehostImage(url, client), null, url);
    await assert.rejects(rehostImage(url, client, { throwOnError: true }), /^Error: download refused/, url);
  }
  assert.deepEqual(fetched, []);
  assert.equal(uploads.length, 0);
});

test('an unresolvable host and an internal one get the same refusal, so the reply reveals no internal names', async t => {
  const { client } = setup(t);
  const refusalFor = async url => (await rehostImage(url, client, { throwOnError: true }).catch(err => err)).message;
  const internal = await refusalFor('http://10.0.0.5/a.png');
  t.mock.method(dns.promises, 'lookup', async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); });
  const unresolvable = await refusalFor('https://missing.example/a.png');
  assert.equal(unresolvable, internal);
  assert.doesNotMatch(internal, /10\.0\.0\.5|missing\.example|ENOTFOUND/);
});

test('an untyped body is archived only when it starts with an image signature', async t => {
  const untyped = bytes => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/octet-stream' } });
  const png = setup(t, { responses: [untyped([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])] });
  assert.equal((await rehostImage('https://cdn.example/screenshot', png.client)).messageId, 'archived');

  const text = setup(t, { responses: [untyped([...Buffer.from('internal status')])] });
  await assert.rejects(rehostImage('https://cdn.example/screenshot', text.client, { throwOnError: true }), /not an image/);
  assert.equal(text.uploads.length, 0);
});

test('a host name that resolves to a private address is refused', async t => {
  const { fetched, uploads, client } = setup(t, {
    lookup: [{ address: '93.184.215.14', family: 4 }, { address: '10.1.2.3', family: 4 }],
  });
  assert.equal(await rehostImage('https://evidence.example/a.png', client), null);
  assert.deepEqual(fetched, []);
  assert.equal(uploads.length, 0);
});

test('a redirect to a private address is not followed', async t => {
  const { fetched, uploads, client } = setup(t, { responses: [redirectTo('http://127.0.0.1/secret')] });
  assert.equal(await rehostImage('https://evidence.example/a.png', client), null);
  assert.deepEqual(fetched, ['https://evidence.example/a.png']);
  assert.equal(uploads.length, 0);
});

test('a body that is not an image is not uploaded', async t => {
  const { uploads, client } = setup(t, {
    responses: [new Response('internal status page', { headers: { 'content-type': 'text/plain' } })],
  });
  await assert.rejects(rehostImage('https://evidence.example/a.png', client, { throwOnError: true }), /not an image/);
  assert.equal(uploads.length, 0);
});

test('a public image is still archived, through a redirect', async t => {
  const { fetched, uploads, client } = setup(t, {
    responses: [redirectTo('https://cdn.example/final.png'), image()],
  });
  const result = await rehostImage('https://evidence.example/a.png', client);
  assert.deepEqual(fetched, ['https://evidence.example/a.png', 'https://cdn.example/final.png']);
  assert.equal(uploads.length, 1);
  assert.equal(result.messageId, 'archived');
});
