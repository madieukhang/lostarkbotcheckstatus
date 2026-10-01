/**
 * handlers/list/notes/pendingNotes.js
 * Holds a duplicate list add in memory until its Add to history button is
 * pressed. The typed reason, raid and evidence do not fit in a custom id;
 * a restart or the TTL drops them and the button answers that the card
 * expired.
 */

import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { t } from '../../../services/i18n/index.js';
import { buildNoteHistoryButton } from './entryNotes.js';

export const NOTE_ADD_PREFIX = 'listnote_add';
// Long enough to read the duplicate card before deciding.
const PENDING_NOTE_TTL_MS = 15 * 60 * 1000;
const pendingNotes = new Map();

/**
 * @param {string} key - from the button custom id
 * @returns {object|null} the held duplicate add, without consuming it
 */
export function peekPendingNote(key) {
  return pendingNotes.get(key) ?? null;
}

/**
 * Consume a held duplicate add so a second click cannot save it twice.
 * @param {string} key - from the button custom id
 * @returns {object|null} the held duplicate add
 */
export function takePendingNote(key) {
  const pending = peekPendingNote(key);
  pendingNotes.delete(key);
  return pending;
}

/**
 * Hold a taken duplicate add again after its save failed, so the card can
 * be pressed again until its original TTL ends.
 * @param {string} key - from the button custom id
 * @param {object} pending - what takePendingNote returned
 * @returns {void}
 */
export function restorePendingNote(key, pending) {
  if (Date.now() < pending.expiresAt) pendingNotes.set(key, pending);
}

/**
 * Hold a duplicate add result and give its card the Add to history
 * button, plus History when the entry already has two notes.
 * @param {object} result - executeListAddToDatabase result
 * @param {object} payload - the add request
 * @param {string} lang - card language
 * @returns {object} the result, with components when it is a duplicate
 */
export function attachNoteControls(result, payload, lang) {
  if (!result.isDuplicate) return result;
  const key = randomBytes(6).toString('hex');
  pendingNotes.set(key, {
    payload,
    lang,
    entryId: String(result.existingEntry._id),
    rosterNames: result.rosterNames,
    rosterCharacters: result.rosterCharacters,
    expiresAt: Date.now() + PENDING_NOTE_TTL_MS,
  });
  setTimeout(() => pendingNotes.delete(key), PENDING_NOTE_TTL_MS).unref();
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`${NOTE_ADD_PREFIX}:${key}`)
      .setLabel(t('common.actions.addToHistory', lang))
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
    buildNoteHistoryButton(payload.type, result.existingEntry, lang),
  ].filter(Boolean);
  return { ...result, components: [new ActionRowBuilder().addComponents(buttons)] };
}
