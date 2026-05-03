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
import { getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
  detectAltsViaStronghold,
} from '../../../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../../services/listCheckService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { COLORS } from '../../../utils/ui.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../../utils/imageRehost.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../../../services/multiaddTemplateService.js';
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

export function createTrustHandlers({ client }) {

  // ─── Trusted user management ──────────────────────────────────────────────

  async function handleListTrustCommand(interaction) {
    const userId = interaction.user.id;
    const isOfficerOrSenior = OFFICER_APPROVER_IDS.includes(userId) || SENIOR_APPROVER_IDS.includes(userId);

    if (!isOfficerOrSenior) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Officer-Only Command',
          description: 'Only officers and seniors can manage the trusted list.',
        })],
        ephemeral: true,
      });
      return;
    }

    const action = interaction.options.getString('action', true);
    const rawName = interaction.options.getString('name', true);
    const name = normalizeCharacterName(rawName);
    const reason = interaction.options.getString('reason') || '';

    await interaction.deferReply();
    await connectDB();

    if (action === 'remove') {
      const deleted = await TrustedUser.findOneAndDelete({ name }).collation({ locale: 'en', strength: 2 });
      if (!deleted) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Not Trusted',
            description: `**${name}** is not in the trusted list, so there's nothing to remove.`,
          })],
        });
        return;
      }

      const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(deleted.name)}/roster`;
      const embed = buildAlertEmbed({
        severity: AlertSeverity.SUCCESS,
        titleIcon: '🛡️',
        color: COLORS.danger,
        title: 'Trusted · Entry Removed',
        fields: [
          { name: 'Name', value: `[${deleted.name}](${rosterLink})`, inline: true },
          { name: 'Was trusted for', value: deleted.reason || 'N/A', inline: true },
          { name: 'Removed by', value: interaction.user.tag, inline: true },
        ],
        footer: 'This character can now be blacklisted.',
      });

      await interaction.editReply({ embeds: [embed] });

      console.log(`[list] Trusted user removed: ${deleted.name} by ${interaction.user.tag}`);
      return;
    }

    // action === 'add'
    const existing = await TrustedUser.findOne({ name }).collation({ locale: 'en', strength: 2 });
    if (existing) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Already Trusted',
          description: `**${existing.name}** is already in the trusted list.`,
        })],
      });
      return;
    }

    // Block trust if character is currently blacklisted (scope-aware)
    const trustGuildId = interaction.guild?.id || '';
    const blacklisted = await Blacklist.findOne(
      buildBlacklistQuery({ $or: [{ name }, { allCharacters: name }] }, trustGuildId)
    ).collation({ locale: 'en', strength: 2 }).lean();
    if (blacklisted) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Blacklisted Character',
          description: `**${name}** is currently blacklisted (entry: **${blacklisted.name}**).`,
          footer: 'Remove the blacklist entry first before trusting this character.',
        })],
      });
      return;
    }

    await TrustedUser.create({
      name,
      reason,
      addedByUserId: userId,
      addedByTag: interaction.user.tag,
    });

    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const embed = buildAlertEmbed({
      severity: AlertSeverity.SUCCESS,
      titleIcon: '🛡️',
      color: COLORS.trustedSoft,
      title: 'Trusted · Entry Added',
      fields: [
        { name: 'Name', value: `[${name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: reason || 'N/A', inline: true },
        { name: 'Added by', value: interaction.user.tag, inline: true },
      ],
      footer: 'This character (and its alts) cannot be added to any list.',
    });

    await interaction.editReply({ embeds: [embed] });

    console.log(`[list] Trusted user added: ${name} by ${interaction.user.tag}`);
  }

  return { handleListTrustCommand };
}
