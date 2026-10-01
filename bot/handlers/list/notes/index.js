/**
 * handlers/list/notes/index.js
 * Button handlers of the note history: opening it, turning its pages and,
 * on a duplicate add card, saving the report as a new note.
 */

import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferEphemeralReply, deferUpdate, editAlert, editPayload, replyAlert } from '../../../utils/interactionReplies.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { getListContext } from '../helpers.js';
import { statMapFromRosterCharacters } from '../trackedAltsRender.js';
import { buildNoteAddedPayload } from './addedCard.js';
import { appendEntryNote, listAddedAlts } from './appendNote.js';
import { buildNoteHistoryPayload } from './historyView.js';
import { NOTE_ADD_PREFIX, peekPendingNote, restorePendingNote, takePendingNote } from './pendingNotes.js';

// Same visibility as the check details card: a server-scoped entry only
// opens inside its own server.
async function loadHistoryEntry(interaction) {
  const [, type, entryId, page] = interaction.customId.split(':');
  await connectDB();
  const entry = await getListContext(type).model.findOne(
    buildScopedListQuery(type, { _id: entryId }, interaction.guild?.id || interaction.guildId || ''),
  ).lean();
  return { type, entry, page: Number(page) };
}

async function renderHistory(interaction, lang) {
  const { type, entry, page } = await loadHistoryEntry(interaction);
  if (!entry) {
    await editAlert(interaction, { severity: AlertSeverity.WARNING, ...t('dialogue.check.entryRemoved', lang), lang });
    return;
  }
  await editPayload(interaction, buildNoteHistoryPayload({ entry, type, page, lang }));
}

/**
 * @param {object} deps
 * @param {object} deps.services - shared list services (broadcastListChange)
 * @returns {{
 *   handleListNoteHistoryButton: Function,
 *   handleListNotePageButton: Function,
 *   handleListNoteAddButton: Function,
 * }}
 */
export function createNoteHandlers({ services }) {
  const languageOf = interaction => getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

  async function handleListNoteHistoryButton(interaction) {
    await deferEphemeralReply(interaction);
    await renderHistory(interaction, await languageOf(interaction));
  }

  async function handleListNotePageButton(interaction) {
    await deferUpdate(interaction);
    await renderHistory(interaction, await languageOf(interaction));
  }

  async function handleListNoteAddButton(interaction) {
    const key = interaction.customId.slice(NOTE_ADD_PREFIX.length + 1);
    const lang = await languageOf(interaction);
    const pending = peekPendingNote(key);
    const refusal = !pending ? 'pendingExpired'
      : pending.payload.requestedByUserId !== interaction.user.id ? 'notYours'
        : null;
    if (refusal) {
      await replyAlert(interaction, { severity: AlertSeverity.WARNING, ...t(`dialogue.notes.${refusal}`, lang), lang });
      return;
    }
    takePendingNote(key);
    const { payload, entryId, rosterNames, rosterCharacters } = pending;
    const { model } = getListContext(payload.type);
    let entry;
    let saved;
    // Taken above so a second click cannot save the report twice; given back
    // when the save fails, which the card key on the note makes safe to retry.
    try {
      await deferUpdate(interaction);
      await connectDB();
      entry = await model.findById(entryId).lean();
      saved = entry ? await appendEntryNote({ model, entry, payload, rosterNames, requestId: key }) : null;
    } catch (err) {
      restorePendingNote(key, pending);
      throw err;
    }
    if (!saved) {
      await editAlert(interaction, { severity: AlertSeverity.WARNING, ...t('dialogue.approval.flow.originalMissing', lang), lang }, { components: [] });
      return;
    }
    const addedAlts = listAddedAlts(entry, saved);
    await editPayload(interaction, buildNoteAddedPayload({
      entry: saved, type: payload.type, addedAlts, statMap: statMapFromRosterCharacters(rosterCharacters), lang: pending.lang,
    }));
    services.broadcastListChange('noted', saved, {
      type: payload.type,
      guildId: payload.guildId,
      requestedByDisplayName: payload.requestedByDisplayName,
      requestedByTag: payload.requestedByTag,
    }, {
      // Server-scoped entries announce to the owner server only, as overwrites did.
      onlyOwner: saved.scope === 'server',
      rosterCharacters,
      newAltNames: addedAlts,
    }).catch((err) => console.warn('[list] Broadcast failed:', err.message));
  }

  return { handleListNoteHistoryButton, handleListNotePageButton, handleListNoteAddButton };
}
