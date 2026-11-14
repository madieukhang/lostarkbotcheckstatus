/**
 * utils/evidenceStore.js
 * Reads and writes the database copy of evidence images (EvidenceImage).
 * The copy is best effort: a failed store is logged and never fails the add,
 * edit or note that archived the image.
 */

import { createHash } from 'node:crypto';
import EvidenceImage from '../models/EvidenceImage.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import Watchlist from '../models/Watchlist.js';
import PendingApproval from '../models/PendingApproval.js';

// A MongoDB document holds at most 16 MB; the margin covers the other fields.
export const EVIDENCE_COPY_MAX_BYTES = 15 * 1024 * 1024;
// Twice the 24-hour life of a pending approval, so a request still waiting
// keeps its image.
export const PENDING_EVIDENCE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const LIST_MODELS = [Blacklist, Whitelist, Watchlist];

/**
 * @param {Buffer} buffer - image bytes
 * @returns {string} SHA-256 of the bytes, hex
 */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Store an image once by its hash, adding the archive message it now has.
 * @param {object} options
 * @param {Buffer} options.buffer - image bytes
 * @param {string} [options.contentType] - MIME type as downloaded
 * @param {string} [options.filename] - file name as archived
 * @param {{messageId: string, channelId: string}|null} [options.archive] - the
 *   evidence-channel message holding this image
 * @param {boolean} [options.pending] - a member's request stored it before any
 *   approval; applies only when the image is new
 * @returns {Promise<string>} the hash, or '' when the image is over the cap or
 *   the write failed
 */
export async function storeEvidenceImage({ buffer, contentType = '', filename = '', archive = null, pending = false }) {
  if (!buffer?.length) return '';
  if (buffer.length > EVIDENCE_COPY_MAX_BYTES) {
    console.warn(`[evidenceStore] ${buffer.length} bytes is over the database copy cap; the archive keeps the only copy`);
    return '';
  }
  const sha256 = sha256Hex(buffer);
  const update = {
    $setOnInsert: { data: buffer, contentType, size: buffer.length, filename, createdAt: new Date(), pending },
    $set: { lastStoredAt: new Date() },
  };
  if (archive?.messageId) {
    Object.assign(update.$set, { archiveMessageId: archive.messageId, archiveChannelId: archive.channelId || '' });
    update.$addToSet = { archiveMessageIds: archive.messageId };
  }
  try {
    await EvidenceImage.updateOne({ _id: sha256 }, update, { upsert: true });
    return sha256;
  } catch (err) {
    console.warn(`[evidenceStore] Database copy failed for ${sha256}:`, err.message);
    return '';
  }
}

/**
 * Find a stored image by hash, or else by an archive message id it has had.
 * @param {{sha256?: string, messageId?: string}} key
 * @param {{withData?: boolean}} [options] - include the bytes
 * @returns {Promise<object|null>} the lean document, or null
 */
export async function findEvidenceImage({ sha256 = '', messageId = '' }, { withData = false } = {}) {
  if (!sha256 && !messageId) return null;
  const query = EvidenceImage.findOne(sha256 ? { _id: sha256 } : { archiveMessageIds: messageId });
  if (!withData) query.select('-data');
  return query.lean();
}

/**
 * Record a new archive message for a stored image.
 * @param {string} sha256 - the image
 * @param {{messageId: string, channelId: string}} archive - the new message
 * @returns {Promise<void>}
 */
export async function recordArchiveCopy(sha256, { messageId, channelId }) {
  await EvidenceImage.updateOne(
    { _id: sha256 },
    {
      $set: { archiveMessageId: messageId, archiveChannelId: channelId },
      $addToSet: { archiveMessageIds: messageId },
    }
  );
}

/**
 * Point list entries at a live archive copy: entries on a message found gone,
 * and entries that carry only this image's hash. Entries on any other message
 * are left alone.
 * @param {object} options
 * @param {string} [options.sha256] - the image, for hash-only entries
 * @param {string[]} [options.goneMessageIds] - archive ids Discord reported gone
 * @param {string} options.messageId - the live archive message
 * @param {string} options.channelId - its channel
 * @returns {Promise<number>} entries changed across the three lists
 */
export async function repointEntries({ sha256 = '', goneMessageIds = [], messageId, channelId }) {
  const matches = [];
  if (goneMessageIds.length > 0) matches.push({ imageMessageId: { $in: goneMessageIds } });
  // An entry edited to a newer direct link keeps its old hash; the empty
  // imageUrl keeps that entry out.
  if (sha256) matches.push({ imageSha256: sha256, imageMessageId: { $in: ['', null] }, imageUrl: { $in: ['', null] } });
  if (matches.length === 0) return 0;
  const results = await Promise.all(LIST_MODELS.map(model => model.updateMany(
    { $or: matches },
    { $set: { imageMessageId: messageId, imageChannelId: channelId } }
  )));
  return results.reduce((sum, result) => sum + (result.modifiedCount || 0), 0);
}

/**
 * @returns {Promise<Set<string>>} every archive message id a stored image has had
 */
export async function listArchivedMessageIds() {
  return new Set(await EvidenceImage.distinct('archiveMessageIds'));
}

/**
 * Whether an evidence-channel message belongs to the evidence archive: a
 * stored image has had it, or a list entry or a pending request points at it.
 * Message ids are unique across Discord, so the id alone decides.
 * @param {string} messageId - the archive message
 * @returns {Promise<boolean>} true when the database knows the message
 */
export async function isKnownArchiveMessage(messageId) {
  if (!messageId) return false;
  const checks = [
    EvidenceImage.exists({ archiveMessageIds: messageId }),
    ...LIST_MODELS.map((model) => model.exists({ imageMessageId: messageId })),
    PendingApproval.exists({ $or: [{ imageMessageId: messageId }, { 'bulkRows.imageMessageId': messageId }] }),
  ];
  return (await Promise.all(checks)).some(Boolean);
}

// Whether a list entry or a pending approval points at the image, by any
// archive message it has had or, for an entry, by its hash.
async function isEvidenceReferenced(image) {
  const messageIds = { $in: image.archiveMessageIds || [] };
  const checks = [
    ...LIST_MODELS.map((model) => model.exists({ $or: [{ imageMessageId: messageIds }, { imageSha256: image._id }] })),
    PendingApproval.exists({ $or: [{ imageMessageId: messageIds }, { 'bulkRows.imageMessageId': messageIds }] }),
  ];
  return (await Promise.all(checks)).some(Boolean);
}

async function deleteArchiveMessages(image, client) {
  try {
    const channel = await client.channels.fetch(image.archiveChannelId);
    await Promise.allSettled((image.archiveMessageIds || []).map((id) => channel.messages.delete(id)));
  } catch (err) {
    console.warn(`[evidenceStore] Archive cleanup for ${image._id} failed:`, err.message);
  }
}

/**
 * Settle the images members' requests stored before any approval: one an
 * entry or request now points at is kept and loses its pending flag; one
 * nothing points at after PENDING_EVIDENCE_MAX_AGE_MS is deleted with its
 * archive messages. The delete matches the age it was judged by, so a store
 * of the same bytes in between keeps the image.
 * @param {object} options
 * @param {import('discord.js').Client} options.client - the bot client
 * @param {number} [options.now] - clock in milliseconds
 * @returns {Promise<{confirmed: number, removed: number}>} images settled
 */
export async function sweepPendingEvidenceImages({ client, now = Date.now() }) {
  const cutoff = new Date(now - PENDING_EVIDENCE_MAX_AGE_MS);
  const images = await EvidenceImage.find({ pending: true }).select('-data').lean();
  const result = { confirmed: 0, removed: 0 };
  for (const image of images) {
    if (await isEvidenceReferenced(image)) {
      await EvidenceImage.updateOne({ _id: image._id }, { $set: { pending: false } });
      result.confirmed += 1;
      continue;
    }
    if (!(image.lastStoredAt <= cutoff)) continue;
    const { deletedCount } = await EvidenceImage.deleteOne({ _id: image._id, pending: true, lastStoredAt: { $lte: cutoff } });
    if (deletedCount !== 1) continue;
    await deleteArchiveMessages(image, client);
    result.removed += 1;
  }
  return result;
}
