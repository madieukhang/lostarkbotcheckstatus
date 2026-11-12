/**
 * handlers/list/form/index.js
 * /la-list add-form and edit-form open their modal; every form submit,
 * Quick-Add's included, runs the /la-list add or edit handler with the
 * request the form read, so the forms share all of the commands' rules.
 */

import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { NoticeKind } from '../../../utils/alertEmbed.js';
import { replyAlert } from '../../../utils/interactionReplies.js';
import {
  buildListAddFormModal,
  buildListEditFormModal,
  readListAddForm,
  readListEditForm,
} from './fields.js';

/**
 * Build the form openers and submit handlers.
 * @param {object} deps
 * @param {Function} deps.handleListAddCommand - (interaction, request?, options?) from add/command.js
 * @param {Function} deps.handleListEditCommand - (interaction, input?) from edit/command.js
 * @returns {{
 *   handleListAddFormCommand: Function,
 *   handleListEditFormCommand: Function,
 *   handleListAddFormSubmit: Function,
 *   handleListEditFormSubmit: Function,
 *   handleQuickAddFormSubmit: Function,
 * }}
 */
export function createListFormHandlers({ handleListAddCommand, handleListEditCommand }) {
  // A modal must be the first answer to the command, so nothing is deferred.
  const openForm = (buildModal) => async (interaction) => {
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    if (!interaction.guild) {
      await replyAlert(interaction, { kind: NoticeKind.GUARD, ...t('dialogue.common.serverOnly', lang) });
      return;
    }
    await interaction.showModal(buildModal(lang));
  };

  return {
    handleListAddFormCommand: openForm(buildListAddFormModal),
    handleListEditFormCommand: openForm(buildListEditFormModal),
    handleListAddFormSubmit: (interaction) => handleListAddCommand(interaction, readListAddForm(interaction.fields)),
    handleListEditFormSubmit: (interaction) => handleListEditCommand(interaction, readListEditForm(interaction.fields)),
    // Quick-Add opens from a public /la-check card, so its answer stays private.
    handleQuickAddFormSubmit: (interaction) => handleListAddCommand(
      interaction,
      readListAddForm(interaction.fields),
      { ephemeral: true },
    ),
  };
}
