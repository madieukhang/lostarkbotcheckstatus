import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import config from '../../../config.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import GuildConfig from '../../../models/GuildConfig.js';
import PendingApproval from '../../../models/PendingApproval.js';
import TrustedUser from '../../../models/TrustedUser.js';
import UserPreference from '../../../models/UserPreference.js';
import { getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
  detectAltsViaStronghold,
} from '../../../services/roster/index.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../../services/list-check/service.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../../utils/imageRehost.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../../../services/multiadd/index.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildListEditSuccessEmbed,
  buildListAddApprovalEmbed,
  getApproverRecipientIds,
  isRequesterAutoApprover,
  isOfficerOrSenior,
  getSeniorApproverIds,
  buildApprovalResultRow,
  buildApprovalProcessingRow,
} from '../helpers.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;

export function createQuickAddHandlers({ client, services }) {
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

    await interaction.deferReply({ ephemeral: true });
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    if (!reason) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Reason Required',
          description: 'Every list entry needs a reason.',
        })],
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

      const payload = {
        requestId: randomUUID(),
        guildId: interaction.guild?.id || '',
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        logsUrl: '',
        imageUrl: '',
        scope: quickScope,
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        lang,
        createdAt: Date.now(),
      };

      // Auto-approve: officers always, OR server-scoped (local = free)
      if (isRequesterAutoApprover(payload.requestedByUserId) || payload.scope === 'server') {
        const result = await executeListAddToDatabase(payload);
        const hasEmbed = (result.embeds?.length ?? 0) > 0;
        await interaction.editReply({
          content: hasEmbed ? null : result.content,
          embeds: result.embeds ?? [],
          components: result.components ?? [],
        });
        return;
      }

      // Non-approver → send approval request
      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Approval Delivery Failed',
            description: sent.reason || 'Could not deliver the approval request.',
          })],
        });
        return;
      }

      await connectDB();
      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.INFO,
          titleIcon: '📨',
          title: 'Approval Request Sent',
          description: `Request to add **${name}** to **${type}list** is awaiting approval.`,
        })],
      });
    } catch (err) {
      console.error('[quickadd] Failed:', err.message);
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Quick Add Failed',
          description: 'Could not process the quick-add request.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
      });
    }
  }

  return { handleQuickAddSelect, handleQuickAddModal };
}
