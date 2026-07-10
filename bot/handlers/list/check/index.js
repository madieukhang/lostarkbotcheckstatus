import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
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
import UserPreference from '../../../models/UserPreference.js';
import { getClassName } from '../../../models/Class.js';
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
import { truncateDiscordContent } from '../../../utils/discordText.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editContent,
  editEmbed,
  replyAlert,
  replyContent,
  replyEmbed,
} from '../../../utils/interactionReplies.js';
import { buildListCheckEmbed } from '../../../utils/listCheckEmbed.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../../utils/imageRehost.js';
import { ICONS } from '../../../utils/ui.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { buildEvidenceEmbed } from '../view/ui.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../../../services/multiadd/index.js';
import {
  getListContext,
  decorateListEntry,
  parseListEntryRef,
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

function pickListEntryWithEvidence(result) {
  for (const [listType, entry] of [
    ['black', result.blackEntry],
    ['white', result.whiteEntry],
    ['watch', result.watchEntry],
  ]) {
    if (entry && (entry.imageMessageId || entry.imageUrl)) {
      return { entry, listType };
    }
  }
  return null;
}

/**
 * Build the auto-check / /la-check evidence dropdown. Lists every result
 * row whose flagged list entry carries an evidence image (rehosted or
 * legacy URL). Each option's value encodes `<listType>:<_id>` so the
 * select handler resolves unambiguously across types and scopes (mirrors
 * /la-evidence's encoding).
 */
export function buildAutoCheckEvidenceRow(results, lang = 'en') {
  const candidates = [];
  for (const result of results) {
    const picked = pickListEntryWithEvidence(result);
    if (!picked) continue;
    candidates.push({
      result,
      entry: picked.entry,
      listType: picked.listType,
    });
  }
  if (candidates.length === 0) return null;

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('autocheck_evidence')
      .setPlaceholder(`${ICONS.evidence} ${t('listView.navigation.evidencePlaceholder', lang)}`)
      .addOptions(
        candidates.slice(0, 25).map(({ result, entry, listType }) => {
          const ctx = getListContext(listType);
          return {
            label: result.name,
            description: (entry.reason || t('listView.navigation.noReason', lang)).slice(0, 100),
            value: `${listType}:${entry._id}`.slice(0, 100),
            emoji: ctx.icon,
          };
        })
      )
  );
}

export function createAutoCheckEvidenceHandler({ client }) {
  return async function handleAutoCheckEvidenceSelect(interaction) {
    const raw = interaction.values?.[0] || '';
    const parsed = parseListEntryRef(raw);

    if (!parsed) {
      await replyContent(interaction, 'Evidence selection malformed (please re-run the check).');
      return;
    }

    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const ctx = getListContext(parsed.listType);
    const entry = await ctx.model.findOne({ _id: parsed.id }).lean();

    if (!entry) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Entry Removed',
        description: 'The list entry behind this evidence row no longer exists.',
      });
      return;
    }

    if (!entry.imageMessageId && !entry.imageUrl) {
      await replyContent(interaction, t('listView.evidence.noImage', lang));
      return;
    }

    const decorated = decorateListEntry(entry, parsed.listType);
    const displayUrl = await resolveDisplayImageUrl(entry, client);
    const isOfficer =
      config.officerApproverIds.includes(interaction.user.id)
      || config.seniorApproverIds.includes(interaction.user.id);

    await replyEmbed(interaction, buildEvidenceEmbed(decorated, displayUrl, { includeAddedBy: isOfficer, lang }));
  };
}

export function createCheckHandlers({ client }) {
  async function handleListCheckCommand(interaction) {
    const image = interaction.options.getAttachment('image', true);
    let names = [];

    await deferReply(interaction);

    try {
      names = await extractNamesFromImage(image, { refineAmbiguousDiacritics: true });
    } catch (err) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'OCR Failed',
        description: 'Could not extract names from the uploaded image.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        footer: 'Try a clearer screenshot, or check that the image is the raid waiting room.',
      });
      return;
    }

    if (names.length === 0) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'No Names Detected',
        description: 'OCR ran but found no valid names in the image.',
        footer: 'Try a clearer screenshot of the raid waiting room.',
      });
      return;
    }

    const maxNames = config.listcheckMaxNames;
    const limitedNames = names.slice(0, maxNames);
    await editContent(interaction, [
      `🔍 Extracted **${limitedNames.length}** name(s) · checking database lists...`,
      limitedNames.length < names.length ? `Ignored **${names.length - limitedNames.length}** extra name(s) (limit: ${maxNames}).` : null,
    ].filter(Boolean).join('\n'));

    try {
      const results = await checkNamesAgainstLists(limitedNames, { guildId: interaction.guild?.id });
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
      const formattedLines = formatCheckResults(results);

      const { embed } = buildListCheckEmbed({
        results,
        formattedLines,
        limitedNamesCount: limitedNames.length,
        ignoredCount: names.length - limitedNames.length,
        maxNames,
        mode: 'slash',
      });

      // Evidence dropdown · mirror of /la-list view's evidence row.
      // Surfaces every flagged row whose list entry has an evidence
      // image so officers can audit without re-running /la-list view.
      const components = [];
      const evidenceRow = buildAutoCheckEvidenceRow(results, lang);
      if (evidenceRow) components.push(evidenceRow);

      await editEmbed(interaction, embed, { content: '', components });
    } catch (err) {
      console.error('[listcheck] ❌ Check failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Check Failed',
        description: 'Could not run the list check after OCR succeeded.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  return {
    handleListCheckCommand,
    handleAutoCheckEvidenceSelect: createAutoCheckEvidenceHandler({ client }),
  };
}
