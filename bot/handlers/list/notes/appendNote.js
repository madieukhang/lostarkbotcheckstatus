/**
 * handlers/list/notes/appendNote.js
 * Saves a duplicate report as a new note on the listed entry: the note,
 * the roster names just fetched and any new screenshot or logs link.
 */

import { normalizeNameKey } from '../../../utils/names.js';
import { buildNoteAppend } from './entryNotes.js';

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
 * @param {Function} [options.beforeWrite] - runs before each write (approval lease check)
 * @returns {Promise<object|null>} the entry as saved, or null when it is gone
 */
export async function appendEntryNote({ model, entry, payload, rosterNames = [], beforeWrite = async () => {} }) {
  const note = {
    at: new Date(),
    reason: payload.reason,
    raid: payload.raid || '',
    byUserId: payload.requestedByUserId || '',
    byName: payload.requestedByDisplayName || payload.requestedByTag || '',
  };
  const set = { ...evidenceSet(payload), ...(payload.logsUrl ? { logsUrl: payload.logsUrl } : {}) };
  const write = async (current) => {
    const { filter, update } = buildNoteAppend(current, note, { rosterNames, set });
    await beforeWrite();
    return model.findOneAndUpdate(filter, update, { new: true }).lean();
  };
  const saved = await write(entry);
  if (saved) return saved;
  // The note count moved since the read: append after the note that landed.
  const reloaded = await model.findById(entry._id).lean();
  return reloaded ? write(reloaded) : null;
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
