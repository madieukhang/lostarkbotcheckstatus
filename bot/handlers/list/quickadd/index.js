/**
 * handlers/list/quickadd/index.js
 * Quick-Add dropdown on the auto-check / /la-check result card · lets
 * an officer one-click an unflagged OCR'd name into a list. Opens the
 * /la-list add form with that name and blacklist chosen; its submit runs
 * /la-list add (handlers/list/form), answered privately.
 */

import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';

import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { normalizeNameKey } from '../../../utils/names.js';
import { resetSelectMenu } from '../../../utils/selectMenu.js';
import { LIST_FORM_IDS, buildListAddFormModal } from '../form/fields.js';

const QUICK_ADD_SELECT_ID = 'quickadd_select';
const SELECT_NONE = 'none';

/**
 * Build the Quick-Add menu. It ends with Select none: a closed form leaves
 * its name picked, and Discord sends nothing when the same name is picked
 * again, so clearing the pick is what lets the form open a second time.
 * @param {Array<{name: string}>} candidates - checked names eligible for Quick Add
 * @param {string} lang - card language
 * @returns {ActionRowBuilder|null} the menu row, or null with no candidate
 */
export function buildQuickAddRow(candidates, lang) {
  const seen = new Set();
  const unique = [];
  for (const result of candidates) {
    const name = String(result?.name || '').trim();
    const key = normalizeNameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
    if (unique.length >= 24) break;
  }
  if (unique.length === 0) return null;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(QUICK_ADD_SELECT_ID)
      .setPlaceholder(t('quickAdd.selectPlaceholder', lang))
      // Discord allows 25 options; the last one is Select none.
      .addOptions(unique.map((name) => ({
        label: name,
        description: t('quickAdd.noListHit', lang),
        value: name,
        emoji: '❓',
      })))
      .addOptions({
        label: t('listView.navigation.selectNone', lang),
        value: SELECT_NONE,
        emoji: '↩️',
      }),
  );
}

/**
 * Build the Quick-Add handler bag.
 * @returns {{handleQuickAddSelect: Function}}
 */
export function createQuickAddHandlers() {
  async function handleQuickAddSelect(interaction) {
    const name = interaction.values[0];
    if (name === SELECT_NONE) {
      await resetSelectMenu(interaction, QUICK_ADD_SELECT_ID);
      return;
    }
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
