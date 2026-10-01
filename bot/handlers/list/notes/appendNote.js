/**
 * handlers/list/notes/appendNote.js
 * Saves a duplicate report as a new note on the listed entry: the note,
 * the roster names just fetched and any new screenshot or logs link.
 */

import { normalizeNameKey } from '../../../utils/names.js';
import { buildNoteAppend } from './entryNotes.js';

// Each lost write re-reads the entry and tries again; reports landing on
// one entry together settle within a few rounds.
const MAX_NOTE_WRITES = 5;

// A new screenshot replaces the evidence, preferring the archived copy;
// without one the entry keeps what it has.
function evidenceSet(payload) {
  if (payload.imageMessageId) {
    return { imageUrl: '', imageMessageId: payload.imageMessageId, imageChannelId: payload.imageChannelId || '' };
  }
  if (payload.imageUrl) return { imageUrl: payload.imageUrl, imageMessageId: '', imageChannelId: '' };
  return {};
}

/**
 * @param {object} options
 * @param {import('mongoose').Model} options.model - the entry's list model
 * @param {object} options.entry - the entry as read
 * @param {object} options.payload - the add request: reason, raid, requester, evidence
 * @param {string[]} [options.rosterNames=[]] - roster names to merge into allCharacters
 * @param {string} [options.requestId=''] - the approval request or duplicate
 *   card being saved; a retry finds its note instead of adding it again
 * @param {Function} [options.beforeWrite] - runs before each write (approval lease check)
 * @returns {Promise<object|null>} the entry as saved, or null when it is gone
 * @throws {Error} when the entry kept changing through every write
 */
export async function appendEntryNote({ model, entry, payload, rosterNames = [], requestId = '', beforeWrite = async () => {} }) {
  const note = {
    at: new Date(),
    reason: payload.reason,
    raid: payload.raid || '',
    byUserId: payload.requestedByUserId || '',
    byName: payload.requestedByDisplayName || payload.requestedByTag || '',
    ...(requestId ? { requestId } : {}),
  };
  const set = { ...evidenceSet(payload), ...(payload.logsUrl ? { logsUrl: payload.logsUrl } : {}) };
  const write = async (current) => {
    const { filter, update } = buildNoteAppend(current, note, { rosterNames, set });
    await beforeWrite();
    return model.findOneAndUpdate(filter, update, { new: true }).lean();
  };
  const landed = current => Boolean(requestId) && (current.notes || []).some(stored => stored.requestId === requestId);

  let current = entry;
  for (let attempt = 0; attempt < MAX_NOTE_WRITES; attempt += 1) {
    if (landed(current)) return current;
    const saved = await write(current);
    if (saved) return saved;
    // A note or an edit landed since the read: append to the entry as it is now.
    current = await model.findById(entry._id).lean();
    if (!current) return null;
  }
  throw new Error(`Entry ${entry._id} kept changing; the note was not saved.`);
}

/**
 * @param {object} before - the entry before the note
 * @param {object} after - the entry as saved
 * @returns {string[]} roster names the note added
 */
export function listAddedAlts(before, after) {
  const known = new Set((before.allCharacters || []).map(normalizeNameKey));
  return (after.allCharacters || []).filter(name => !known.has(normalizeNameKey(name)));
}
