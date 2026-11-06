import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../bot/config.js';
import GuildConfig from '../bot/models/GuildConfig.js';
import EvidenceImage from '../bot/models/EvidenceImage.js';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import { invalidateGuildConfig } from '../bot/utils/scope.js';
import { resolveDisplayImageUrl } from '../bot/utils/imageRehost.js';

const STORED = Buffer.from('89504e470d0a1a0a', 'hex');
const gone = code => Object.assign(new Error('Discord refused'), { code });

// archive: message id -> image URL, or an Error the fetch throws.
// image: the EvidenceImage document a lookup finds, or null.
function setup(t, { archive = {}, image = null } = {}) {
  const ownerGuildId = config.ownerGuildId;
  config.ownerGuildId = 'evidence-heal-owner';
  t.after(() => { config.ownerGuildId = ownerGuildId; invalidateGuildConfig('evidence-heal-owner'); });
  t.mock.method(GuildConfig, 'findOne', () => ({ lean: async () => ({ evidenceChannelId: 'evidence' }) }));
  t.mock.method(console, 'warn', () => {});

  const lookups = [];
  t.mock.method(EvidenceImage, 'findOne', filter => {
    const query = {
      withData: true,
      select(projection) { if (projection === '-data') query.withData = false; return query; },
      async lean() {
        lookups.push({ filter, withData: query.withData });
        if (!image) return null;
        return query.withData ? { ...image, data: STORED } : { ...image };
      },
    };
    return query;
  });
  const records = [];
  t.mock.method(EvidenceImage, 'updateOne', async (filter, update) => { records.push({ filter, update }); return {}; });
  const repoints = [];
  for (const model of [Blacklist, Whitelist, Watchlist]) {
    t.mock.method(model, 'updateMany', async (filter, update) => { repoints.push({ filter, update }); return { modifiedCount: 1 }; });
  }

  const sends = [];
  const channel = {
    id: 'evidence',
    isTextBased: () => true,
    messages: {
      fetch: async ({ message }) => {
        const answer = archive[message] ?? gone(10008);
        if (answer instanceof Error) throw answer;
        return { attachments: { first: () => ({ url: answer }) } };
      },
    },
    send: async payload => {
      sends.push(payload);
      await new Promise(resolve => setImmediate(resolve));
      return { id: `new${sends.length}`, attachments: { first: () => ({ url: `https://cdn.test/new${sends.length}.png` }) } };
    },
  };
  const client = { channels: { fetch: async () => channel } };
  return { client, lookups, records, repoints, sends };
}

const lostImage = { _id: 'sha', archiveMessageId: 'm2', archiveChannelId: 'evidence', archiveMessageIds: ['m1', 'm2'], filename: 'proof.png' };
const onM1 = { name: 'Target', imageMessageId: 'm1', imageChannelId: 'evidence' };

test('a live archive copy is used without reading the database', async t => {
  const { client, lookups } = setup(t, { archive: { m1: 'https://cdn.test/m1.png' } });
  assert.equal(await resolveDisplayImageUrl(onM1, client), 'https://cdn.test/m1.png');
  assert.equal(lookups.length, 0);
});

test('a gone copy falls back to the image\'s newest live copy and re-points the entry', async t => {
  const { client, lookups, repoints, sends } = setup(t, {
    archive: { m2: 'https://cdn.test/m2.png' },
    image: lostImage,
  });

  assert.equal(await resolveDisplayImageUrl(onM1, client), 'https://cdn.test/m2.png');
  assert.deepEqual(lookups[0], { filter: { archiveMessageIds: 'm1' }, withData: false });
  assert.equal(sends.length, 0);
  assert.equal(repoints.length, 3);
  assert.deepEqual(repoints[0].filter.$or[0], { imageMessageId: { $in: ['m1'] } });
  assert.deepEqual(repoints[0].update.$set, { imageMessageId: 'm2', imageChannelId: 'evidence' });
});

test('when every archive copy is gone the stored bytes are re-posted and recorded', async t => {
  const { client, records, repoints, sends } = setup(t, { image: lostImage });

  assert.equal(await resolveDisplayImageUrl(onM1, client), 'https://cdn.test/new1.png');
  assert.equal(sends.length, 1);
  assert.ok(sends[0].files[0].attachment.equals(STORED));
  assert.equal(sends[0].files[0].name, 'proof.png');
  assert.match(sends[0].embeds[0].toJSON().title, /Restored from database/);
  assert.match(sends[0].embeds[0].toJSON().description, /Target/);
  assert.equal(records[0].filter._id, 'sha');
  assert.equal(records[0].update.$addToSet.archiveMessageIds, 'new1');
  assert.deepEqual(repoints[0].filter.$or[0], { imageMessageId: { $in: ['m1', 'm2'] } });
  assert.deepEqual(repoints[0].update.$set, { imageMessageId: 'new1', imageChannelId: 'evidence' });
});

test('a hash-only entry is posted to the archive the first time it is shown', async t => {
  const { client, lookups, repoints, sends } = setup(t, {
    image: { _id: 'sha', archiveMessageId: '', archiveChannelId: '', archiveMessageIds: [], filename: 'image-9.png' },
  });

  assert.equal(await resolveDisplayImageUrl({ name: 'Juntakssss', imageSha256: 'sha' }, client), 'https://cdn.test/new1.png');
  assert.deepEqual(lookups[0].filter, { _id: 'sha' });
  assert.equal(sends.length, 1);
  assert.deepEqual(repoints[0].filter.$or, [{ imageSha256: 'sha', imageMessageId: { $in: ['', null] } }]);
});

test('a transient refresh failure does not heal', async t => {
  const { client, lookups, sends } = setup(t, {
    archive: { m1: Object.assign(new Error('Service Unavailable'), { status: 503 }) },
    image: lostImage,
  });
  assert.equal(await resolveDisplayImageUrl(onM1, client), '');
  assert.equal(lookups.length, 0);
  assert.equal(sends.length, 0);
});

test('heal false never re-posts', async t => {
  const { client, sends } = setup(t, { image: lostImage });
  assert.equal(await resolveDisplayImageUrl(onM1, client, { heal: false }), '');
  assert.equal(sends.length, 0);
});

test('concurrent opens of one lost image re-post it once', async t => {
  const { client, sends } = setup(t, { image: lostImage });
  const [first, second] = await Promise.all([
    resolveDisplayImageUrl(onM1, client),
    resolveDisplayImageUrl({ ...onM1, name: 'Other' }, client),
  ]);
  assert.equal(sends.length, 1);
  assert.equal(first, 'https://cdn.test/new1.png');
  assert.equal(second, first);
});

test('a lost image with no database copy resolves as today', async t => {
  const { client, sends } = setup(t, { image: null });
  const entry = { ...onM1, imageUrl: 'https://img.example/proof.png' };
  assert.equal(await resolveDisplayImageUrl(entry, client), 'https://img.example/proof.png');
  assert.equal(sends.length, 0);
});
