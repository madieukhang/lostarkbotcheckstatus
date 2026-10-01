/**
 * handlers/list/notes/index.js
 * Button handlers of the note history: opening it, turning its pages and,
 * on a duplicate add card, saving the report as a new note.
 */

import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferEphemeralReply, deferUpdate, editAlert, editPayload } from '../../../utils/interactionReplies.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { getListContext } from '../helpers.js';
import { buildNoteHistoryPayload } from './historyView.js';

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
 * @returns {{handleListNoteHistoryButton: Function, handleListNotePageButton: Function}}
 */
export function createNoteHandlers() {
  const languageOf = interaction => getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

  async function handleListNoteHistoryButton(interaction) {
    await deferEphemeralReply(interaction);
    await renderHistory(interaction, await languageOf(interaction));
  }

  async function handleListNotePageButton(interaction) {
    await deferUpdate(interaction);
    await renderHistory(interaction, await languageOf(interaction));
  }

  return { handleListNoteHistoryButton, handleListNotePageButton };
}
