/**
 * handlers/list/quickadd/index.js
 * Quick-Add dropdown on the auto-check / /la-check result card · lets
 * an officer one-click an unflagged OCR'd name into a list. Opens the
 * /la-list add form with that name and blacklist chosen; its submit runs
 * /la-list add (handlers/list/form), answered privately.
 */

import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage } from '../../../services/i18n/index.js';
import { LIST_FORM_IDS, buildListAddFormModal } from '../form/fields.js';

/**
 * Build the Quick-Add handler bag.
 * @returns {{handleQuickAddSelect: Function}}
 */
export function createQuickAddHandlers() {
  async function handleQuickAddSelect(interaction) {
    const name = interaction.values[0];
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    await interaction.showModal(buildListAddFormModal(lang, {
      customId: LIST_FORM_IDS.quickAddModal,
      name,
      chosenType: 'black',
    }));
  }

  return { handleQuickAddSelect };
}
