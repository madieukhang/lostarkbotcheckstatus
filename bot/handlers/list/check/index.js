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
import GuildConfig from '../../../models/GuildConfig.js';
import PendingApproval from '../../../models/PendingApproval.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
} from '../../../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../../services/listCheckService.js';
import { queueFlaggedListEntryEnrichment } from '../../../services/listCheckEnrichment.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { truncateDiscordContent } from '../../../utils/discordText.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
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

export function createCheckHandlers({ client }) {
  async function handleListCheckCommand(interaction) {
    const image = interaction.options.getAttachment('image', true);
    let names = [];

    await interaction.deferReply();

    try {
      names = await extractNamesFromImage(image);
    } catch (err) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'OCR Failed',
          description: 'Could not extract names from the uploaded image.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
          footer: 'Try a clearer screenshot, or check that the image is the raid waiting room.',
        })],
      });
      return;
    }

    if (names.length === 0) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'No Names Detected',
          description: 'OCR ran but found no valid names in the image.',
          footer: 'Try a clearer screenshot of the raid waiting room.',
        })],
      });
      return;
    }

    const maxNames = config.listcheckMaxNames;
    const limitedNames = names.slice(0, maxNames);
    await interaction.editReply({
      content: [
        `🔍 Extracted **${limitedNames.length}** name(s) · checking lists & roster...`,
        limitedNames.length < names.length ? `Ignored **${names.length - limitedNames.length}** extra name(s) (limit: ${maxNames}).` : null,
      ].filter(Boolean).join('\n'),
    });

    try {
      const results = await checkNamesAgainstLists(limitedNames, { guildId: interaction.guild?.id });
      const lines = formatCheckResults(results);

      // Per-category counts drive the title color, the inline stat fields,
      // and the breakdown line at the top of the description. Computed
      // once here so all three readers share the same source of truth.
      const counts = { black: 0, watch: 0, white: 0, trusted: 0, clean: 0, noRoster: 0 };
      for (const r of results) {
        if (r.blackEntry) counts.black++;
        else if (r.watchEntry) counts.watch++;
        else if (r.whiteEntry) counts.white++;
        else if (r.trustedEntry) counts.trusted++;
        else if (r.hasRoster) counts.clean++;
        else counts.noRoster++;
      }

      const flaggedCount = counts.black + counts.watch;
      let color;
      let titleIcon;
      if (counts.black > 0) { color = 0xed4245; titleIcon = '⛔'; }
      else if (counts.watch > 0) { color = 0xfee75c; titleIcon = '⚠️'; }
      else if (counts.white > 0 || counts.trusted > 0) { color = 0x57f287; titleIcon = '✅'; }
      else { color = 0x5865f2; titleIcon = '🔍'; }

      // Top-of-description summary breakdown line. Bolded to anchor the
      // reader's eye before they scan the per-name list below. Skipped
      // entirely when no flags or successes exist (just clean+noRoster).
      const summaryParts = [];
      if (counts.black) summaryParts.push(`⛔ **${counts.black}**`);
      if (counts.watch) summaryParts.push(`⚠️ **${counts.watch}**`);
      if (counts.white) summaryParts.push(`✅ **${counts.white}**`);
      if (counts.trusted) summaryParts.push(`🛡️ **${counts.trusted}**`);
      if (counts.clean) summaryParts.push(`❓ **${counts.clean}** clean`);
      if (counts.noRoster) summaryParts.push(`⚪ **${counts.noRoster}** no roster`);

      const headerLine = summaryParts.length > 0
        ? `**Outcome:** ${summaryParts.join(' · ')}`
        : `Scanned **${limitedNames.length}** name(s) against the lists.`;

      const ignoreNote = limitedNames.length < names.length
        ? `\n*Ignored ${names.length - limitedNames.length} extra name(s) (cap: ${maxNames}).*`
        : '';

      // Discord description ceiling is 4096; for typical OCR runs (10-30
      // names) the joined lines come in well under that. The slice is a
      // safety net for unusually long reasons or many similar-name hits.
      const description = (`${headerLine}${ignoreNote}\n\n${lines.join('\n')}`).slice(0, 4096);

      const fields = [
        { name: '🔍 Checked', value: String(limitedNames.length), inline: true },
        { name: '🚨 Flagged', value: String(flaggedCount), inline: true },
        { name: '✅ Cleared', value: String(counts.white + counts.trusted + counts.clean), inline: true },
      ];

      const footerParts = [];
      if (flaggedCount > 0) {
        footerParts.push('Tip: /la-roster <name> for the full roster of any flagged hit.');
      } else {
        footerParts.push('No flags. Re-run with a fresh image to re-check.');
      }
      footerParts.push('Source: blacklist + whitelist + watchlist + trusted');

      const embed = new EmbedBuilder()
        .setTitle(`${titleIcon} List Check · ${limitedNames.length} name(s)`)
        .setDescription(description)
        .setColor(color)
        .addFields(fields)
        .setFooter({ text: footerParts.join(' · ') })
        .setTimestamp();

      await interaction.editReply({ content: '', embeds: [embed] });

      queueFlaggedListEntryEnrichment(results, { logPrefix: 'listcheck' });
    } catch (err) {
      console.error('[listcheck] ❌ Check failed:', err.message);
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Check Failed',
          description: 'Could not run the list check after OCR succeeded.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
      });
    }
  }

  return { handleListCheckCommand };
}
