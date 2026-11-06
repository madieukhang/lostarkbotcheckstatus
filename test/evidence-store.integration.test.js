import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Blacklist from '../bot/models/Blacklist.js';
import Watchlist from '../bot/models/Watchlist.js';
import EvidenceImage from '../bot/models/EvidenceImage.js';
import {
  EVIDENCE_COPY_MAX_BYTES,
  findEvidenceImage,
  repointEntries,
  sha256Hex,
  storeEvidenceImage,
} from '../bot/utils/evidenceStore.js';

let mongo;
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Blacklist.init(), Watchlist.init(), EvidenceImage.init()]);
});
test.after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test.beforeEach(async () => {
  await Promise.all([Blacklist.deleteMany({}), Watchlist.deleteMany({}), EvidenceImage.deleteMany({})]);
});

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test('the same bytes are stored once and keep every archive id', async () => {
  const first = await storeEvidenceImage({ buffer: png, contentType: 'image/png', filename: 'a.png', archive: { messageId: 'm1', channelId: 'c1' } });
  const second = await storeEvidenceImage({ buffer: png, contentType: 'image/png', filename: 'b.png', archive: { messageId: 'm2', channelId: 'c1' } });

  assert.equal(first, sha256Hex(png));
  assert.equal(second, first);
  const docs = await EvidenceImage.find({}).lean();
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0].archiveMessageIds, ['m1', 'm2']);
  assert.equal(docs[0].archiveMessageId, 'm2');
  assert.equal(docs[0].archiveChannelId, 'c1');
  assert.equal(docs[0].filename, 'a.png');
  assert.equal(docs[0].size, png.length);
});

test('an image over the cap is not stored', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const sha = await storeEvidenceImage({ buffer: Buffer.alloc(EVIDENCE_COPY_MAX_BYTES + 1), archive: { messageId: 'm1', channelId: 'c1' } });
  assert.equal(sha, '');
  assert.equal(await EvidenceImage.countDocuments(), 0);
});

test('a lookup by archive id leaves the bytes out unless asked', async () => {
  const sha = await storeEvidenceImage({ buffer: png, archive: { messageId: 'm1', channelId: 'c1' } });

  const light = await findEvidenceImage({ messageId: 'm1' });
  assert.equal(light._id, sha);
  assert.equal('data' in light, false);
  const full = await findEvidenceImage({ messageId: 'm1' }, { withData: true });
  assert.ok(Buffer.from(full.data.buffer ?? full.data).equals(png));
  assert.equal((await findEvidenceImage({ sha256: sha }))._id, sha);
  assert.equal(await findEvidenceImage({ messageId: 'unknown' }), null);
});

test('repointEntries moves entries on gone ids and hash-only entries', async () => {
  const sha = sha256Hex(png);
  const onGone = await Blacklist.create({ name: 'Gone', imageMessageId: 'm1', imageChannelId: 'c1' });
  const hashOnly = await Watchlist.create({ name: 'Hashonly', imageSha256: sha });

  const moved = await repointEntries({ sha256: sha, goneMessageIds: ['m1'], messageId: 'm9', channelId: 'c9' });

  assert.equal(moved, 2);
  for (const [model, id] of [[Blacklist, onGone._id], [Watchlist, hashOnly._id]]) {
    const entry = await model.findById(id).lean();
    assert.equal(entry.imageMessageId, 'm9');
    assert.equal(entry.imageChannelId, 'c9');
  }
});

test('repointEntries leaves entries on other messages alone', async () => {
  const sha = sha256Hex(png);
  const elsewhere = await Blacklist.create({ name: 'Elsewhere', imageMessageId: 'm5', imageChannelId: 'c1', imageSha256: sha });

  const moved = await repointEntries({ sha256: sha, goneMessageIds: ['m1'], messageId: 'm9', channelId: 'c9' });

  assert.equal(moved, 0);
  assert.equal((await Blacklist.findById(elsewhere._id).lean()).imageMessageId, 'm5');
});

test('repointEntries leaves a hash entry that has a newer direct link alone', async () => {
  const sha = sha256Hex(png);
  const edited = await Blacklist.create({ name: 'Edited', imageSha256: sha, imageUrl: 'https://img.example/new.png' });

  const moved = await repointEntries({ sha256: sha, messageId: 'm9', channelId: 'c9' });

  assert.equal(moved, 0);
  assert.equal((await Blacklist.findById(edited._id).lean()).imageMessageId, '');
});

test('a failing store returns an empty hash instead of throwing', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(EvidenceImage, 'updateOne', async () => { throw new Error('down'); });
  assert.equal(await storeEvidenceImage({ buffer: png, archive: { messageId: 'm1', channelId: 'c1' } }), '');
});

test('a list entry accepts imageSha256 and defaults it to empty', async () => {
  const plain = await Blacklist.create({ name: 'Plain' });
  const hashed = await Blacklist.create({ name: 'Hashed', imageSha256: 'abc' });
  assert.equal(plain.imageSha256, '');
  assert.equal(hashed.imageSha256, 'abc');
});
