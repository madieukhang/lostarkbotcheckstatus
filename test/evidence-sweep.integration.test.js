import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Blacklist from '../bot/models/Blacklist.js';
import Whitelist from '../bot/models/Whitelist.js';
import Watchlist from '../bot/models/Watchlist.js';
import PendingApproval from '../bot/models/PendingApproval.js';
import EvidenceImage from '../bot/models/EvidenceImage.js';
import { storeEvidenceImage, sweepPendingEvidenceImages, PENDING_EVIDENCE_MAX_AGE_MS } from '../bot/utils/evidenceStore.js';

let mongo;
test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Blacklist.init(), Whitelist.init(), Watchlist.init(), PendingApproval.init(), EvidenceImage.init()]);
});
test.after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
test.beforeEach(async () => {
  await Promise.all([Blacklist, Whitelist, Watchlist, PendingApproval, EvidenceImage].map((model) => model.deleteMany({})));
});

const OLD = Date.now() - PENDING_EVIDENCE_MAX_AGE_MS - 60_000;
const pngWith = (tag) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(tag)]);

// A client whose evidence channel records the archive messages deleted.
function fakeClient() {
  const deleted = [];
  return {
    deleted,
    channels: { fetch: async () => ({ messages: { delete: async (id) => { deleted.push(id); } } }) },
  };
}

async function storePending(tag, messageId, { at = OLD } = {}) {
  const sha256 = await storeEvidenceImage({
    buffer: pngWith(tag), contentType: 'image/png', filename: `${tag}.png`,
    archive: { messageId, channelId: 'evidence' }, pending: true,
  });
  await EvidenceImage.updateOne({ _id: sha256 }, { $set: { lastStoredAt: new Date(at) } });
  return sha256;
}

test('an old pending image no entry or request keeps is removed with its archive message', async () => {
  const sha = await storePending('orphan', 'm-orphan');
  const client = fakeClient();
  const result = await sweepPendingEvidenceImages({ client });

  assert.deepEqual(result, { confirmed: 0, removed: 1 });
  assert.equal(await EvidenceImage.countDocuments({ _id: sha }), 0);
  assert.deepEqual(client.deleted, ['m-orphan']);
});

test('a pending image an entry or a pending request points at is kept and confirmed', async () => {
  const byMessage = await storePending('entry', 'm-entry');
  await Whitelist.create({ name: 'Keepone', reason: 'r', imageMessageId: 'm-entry', imageChannelId: 'evidence' });
  const bySha = await storePending('sha', 'm-sha');
  await Blacklist.create({ name: 'Keeptwo', reason: 'r', imageSha256: bySha });
  const byRequest = await storePending('request', 'm-request');
  await PendingApproval.create({ requestId: 'req-1', guildId: 'g', channelId: 'c', name: 'Keepthree', type: 'black', requestedByUserId: 'u', imageMessageId: 'm-request' });
  const byBulkRow = await storePending('bulk', 'm-bulk');
  await PendingApproval.create({
    requestId: 'req-2', guildId: 'g', channelId: 'c', action: 'bulk', type: 'black', requestedByUserId: 'u',
    bulkRows: [{ name: 'Keepfour', type: 'black', imageMessageId: 'm-bulk' }],
  });

  const client = fakeClient();
  const result = await sweepPendingEvidenceImages({ client });

  assert.deepEqual(result, { confirmed: 4, removed: 0 });
  assert.deepEqual(client.deleted, []);
  for (const sha of [byMessage, bySha, byRequest, byBulkRow]) {
    const doc = await EvidenceImage.findById(sha).lean();
    assert.equal(doc.pending, false, `confirmed ${sha}`);
  }
});

test('a recent pending image and an image never marked pending are left alone', async () => {
  const recent = await storePending('recent', 'm-recent', { at: Date.now() });
  const confirmed = await storeEvidenceImage({ buffer: pngWith('old-kept'), archive: { messageId: 'm-kept', channelId: 'evidence' } });
  await EvidenceImage.updateOne({ _id: confirmed }, { $set: { lastStoredAt: new Date(OLD) } });

  const result = await sweepPendingEvidenceImages({ client: fakeClient() });

  assert.deepEqual(result, { confirmed: 0, removed: 0 });
  assert.equal(await EvidenceImage.countDocuments({ _id: { $in: [recent, confirmed] } }), 2);
});

test('storing the same image again restarts its age, so a fresh upload is not swept', async () => {
  const sha = await storePending('again', 'm-first');
  await storeEvidenceImage({ buffer: pngWith('again'), archive: { messageId: 'm-second', channelId: 'evidence' }, pending: true });

  const result = await sweepPendingEvidenceImages({ client: fakeClient() });

  assert.deepEqual(result, { confirmed: 0, removed: 0 });
  assert.equal(await EvidenceImage.countDocuments({ _id: sha }), 1);
});

test('storing a confirmed image again does not mark it pending', async () => {
  const sha = await storeEvidenceImage({ buffer: pngWith('kept'), archive: { messageId: 'm1', channelId: 'evidence' } });
  await storeEvidenceImage({ buffer: pngWith('kept'), archive: { messageId: 'm2', channelId: 'evidence' }, pending: true });
  assert.equal((await EvidenceImage.findById(sha).lean()).pending, false);
});

test('an archive message is known when a stored image, an entry or a request points at it', async () => {
  const { isKnownArchiveMessage } = await import('../bot/utils/evidenceStore.js');
  await storeEvidenceImage({
    buffer: pngWith('known'), contentType: 'image/png', filename: 'known.png',
    archive: { messageId: 'm-stored', channelId: 'old-evidence' },
  });
  await Whitelist.create({ name: 'Knownentry', reason: 'r', imageMessageId: 'm-entry', imageChannelId: 'old-evidence' });
  await PendingApproval.create({ requestId: 'req-k', guildId: 'g', channelId: 'c', name: 'Knownreq', type: 'black', requestedByUserId: 'u', imageMessageId: 'm-request' });
  for (const id of ['m-stored', 'm-entry', 'm-request']) assert.equal(await isKnownArchiveMessage(id), true, id);
  for (const id of ['m-unknown', '']) assert.equal(await isKnownArchiveMessage(id), false, id || 'empty');
});
