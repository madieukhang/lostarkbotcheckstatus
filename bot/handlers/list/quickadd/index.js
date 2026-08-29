/**
 * handlers/list/quickadd/index.js
 * Quick-Add dropdown on the auto-check / /la-check result card · lets
 * an officer one-click an unflagged OCR'd name into a list. Opens a
 * modal for reason + raid + scope, then routes through the same
 * approval pipeline as /la-list add (auto-approve for officers,
 * approver DM fan-out for everyone else).
 */

import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { getGuildConfig } from '../../../utils/scope.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferEphemeralReply,
  editAlert,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  buildListMutationPayload,
  submitListMutation,
} from '../services/mutationFlow.js';

/**
 * Build the Quick-Add handler bag.
 * @param {object} deps
 * @param {object} deps.services - shared approval-flow services
 *   (sendListAddApprovalToApprovers, executeListAddToDatabase)
 * @returns {{
 *   handleQuickAddSelect: Function,
 *   handleQuickAddModalSubmit: Function,
 * }}
 */
export function createQuickAddHandlers({ services }) {
  const { sendListAddApprovalToApprovers, executeListAddToDatabase } = services;

  async function handleQuickAddSelect(interaction) {
    const name = interaction.values[0];
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    const modal = new ModalBuilder()
      .setCustomId(`quickadd_modal:${name}`)
      .setTitle(t('quickAdd.modalTitle', lang, { name }).slice(0, 45))
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_type')
            .setLabel(t('quickAdd.typeLabel', lang))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t('quickAdd.typePlaceholder', lang))
            .setValue('black')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_reason')
            .setLabel(t('quickAdd.reasonLabel', lang))
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder(t('quickAdd.reasonPlaceholder', lang))
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_raid')
            .setLabel(t('quickAdd.raidLabel', lang))
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(t('quickAdd.raidPlaceholder', lang))
            .setRequired(false)
        ),
      );

    await interaction.showModal(modal);
  }

  async function handleQuickAddModal(interaction) {
    const name = interaction.customId.split(':')[1];
    let type = interaction.fields.getTextInputValue('quickadd_type').trim().toLowerCase();
    const reason = interaction.fields.getTextInputValue('quickadd_reason').trim();
    const raid = interaction.fields.getTextInputValue('quickadd_raid')?.trim() || '';

    // Validate type
    if (!['black', 'white', 'watch'].includes(type)) type = 'black';

    await deferEphemeralReply(interaction);
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    if (!reason) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.listAdd.command.reasonRequired', lang),
        lang,
      });
      return;
    }

    try {
      // Resolve scope from guild default setting
      let quickScope = 'global';
      if (type === 'black' && interaction.guild?.id) {
        const gc = await getGuildConfig(interaction.guild.id);
        quickScope = gc?.defaultBlacklistScope || 'global';
      }

      const payload = buildListMutationPayload({
        interaction,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        lang,
        type,
        name,
        reason,
        raid,
        logsUrl: '',
        imageUrl: '',
        scope: quickScope,
      });

      await submitListMutation({
        interaction,
        payload,
        lang,
        PendingApprovalModel: PendingApproval,
        sendListAddApprovalToApprovers,
        executeListAddToDatabase,
        onDeliveryFailed: (delivery) => editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: t('dialogue.quickAdd.deliveryFailed.title', lang),
          description: delivery.reason || t('dialogue.quickAdd.deliveryFailed.fallback', lang),
          lang,
        }),
        onQueued: () => editAlert(interaction, {
          severity: AlertSeverity.INFO,
          titleIcon: '📨',
          ...t('dialogue.quickAdd.sent', lang, { name, list: t(`dialogue.broadcast.list.${type}`, lang) }),
          lang,
        }),
      });
    } catch (err) {
      console.error('[quickadd] Failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.quickAdd.failed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
    }
  }

  return { handleQuickAddSelect, handleQuickAddModal };
}
