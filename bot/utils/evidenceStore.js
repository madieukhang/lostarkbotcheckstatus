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

// A MongoDB document holds at most 16 MB; the margin covers the other fields.
export const EVIDENCE_COPY_MAX_BYTES = 15 * 1024 * 1024;

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
 * @returns {Promise<string>} the hash, or '' when the image is over the cap or
 *   the write failed
 */
export async function storeEvidenceImage({ buffer, contentType = '', filename = '', archive = null }) {
  if (!buffer?.length) return '';
  if (buffer.length > EVIDENCE_COPY_MAX_BYTES) {
    console.warn(`[evidenceStore] ${buffer.length} bytes is over the database copy cap; the archive keeps the only copy`);
    return '';
  }
  const sha256 = sha256Hex(buffer);
  const update = {
    $setOnInsert: { data: buffer, contentType, size: buffer.length, filename, createdAt: new Date() },
  };
  if (archive?.messageId) {
    update.$set = { archiveMessageId: archive.messageId, archiveChannelId: archive.channelId || '' };
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
  const filter = sha256 ? { _id: sha256 } : (messageId ? { archiveMessageIds: messageId } : null);
  if (!filter) return null;
  const query = EvidenceImage.findOne(filter);
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
  if (sha256) matches.push({ imageSha256: sha256, imageMessageId: { $in: ['', null] } });
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
