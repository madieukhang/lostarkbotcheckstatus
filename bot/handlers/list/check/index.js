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
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { buildListCheckEmbed } from '../../../utils/listCheckEmbed.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../../utils/imageRehost.js';
import { COLORS, ICONS } from '../../../utils/ui.js';
import { buildEvidenceEmbed } from '../view/ui.js';
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

/**
 * Per-list-type style metadata for the auto-check evidence dropdown.
 * Mirrors the style helper used by /la-search and /la-list view so the
 * three evidence surfaces render the same icon/color vocabulary.
 */
function evidenceStyleForListType(listType) {
  if (listType === 'black') return { emoji: '⛔', label: 'blacklist', color: COLORS.danger };
  if (listType === 'white') return { emoji: '✅', label: 'whitelist', color: COLORS.success };
  return { emoji: '⚠️', label: 'watchlist', color: COLORS.warning };
}

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
export function buildAutoCheckEvidenceRow(results) {
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
      .setPlaceholder(`${ICONS.evidence} View evidence for...`)
      .addOptions(
        candidates.slice(0, 25).map(({ result, entry, listType }) => {
          const style = evidenceStyleForListType(listType);
          return {
            label: result.name,
            description: (entry.reason || 'No reason').slice(0, 100),
            value: `${listType}:${entry._id}`.slice(0, 100),
            emoji: style.emoji,
          };
        })
      )
  );
}

const KNOWN_EVIDENCE_TYPES = ['black', 'white', 'watch'];
const EVIDENCE_OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function parseEvidenceValue(raw) {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx >= raw.length - 1) return null;
  const listType = raw.slice(0, idx);
  const id = raw.slice(idx + 1).trim();
  if (!KNOWN_EVIDENCE_TYPES.includes(listType)) return null;
  if (!EVIDENCE_OBJECT_ID_RE.test(id)) return null;
  return { listType, id };
}

export function createAutoCheckEvidenceHandler({ client }) {
  return async function handleAutoCheckEvidenceSelect(interaction) {
    const raw = interaction.values?.[0] || '';
    const parsed = parseEvidenceValue(raw);

    if (!parsed) {
      await interaction.reply({
        content: 'Evidence selection malformed (please re-run the check).',
        ephemeral: true,
      });
      return;
    }

    await connectDB();
    const ctx = getListContext(parsed.listType);
    const entry = await ctx.model.findOne({ _id: parsed.id }).lean();

    if (!entry) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Entry Removed',
          description: 'The list entry behind this evidence row no longer exists.',
        })],
        ephemeral: true,
      });
      return;
    }

    if (!entry.imageMessageId && !entry.imageUrl) {
      await interaction.reply({
        content: 'No evidence image for this entry.',
        ephemeral: true,
      });
      return;
    }

    const style = evidenceStyleForListType(parsed.listType);
    const decorated = {
      ...entry,
      _icon: style.emoji,
      _label: style.label,
      _color: style.color,
    };
    const displayUrl = await resolveDisplayImageUrl(entry, client);
    const isOfficer =
      config.officerApproverIds.includes(interaction.user.id)
      || config.seniorApproverIds.includes(interaction.user.id);

    await interaction.reply({
      embeds: [buildEvidenceEmbed(decorated, displayUrl, { includeAddedBy: isOfficer })],
      ephemeral: true,
    });
  };
}

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
        `🔍 Extracted **${limitedNames.length}** name(s) · checking database lists...`,
        limitedNames.length < names.length ? `Ignored **${names.length - limitedNames.length}** extra name(s) (limit: ${maxNames}).` : null,
      ].filter(Boolean).join('\n'),
    });

    try {
      const results = await checkNamesAgainstLists(limitedNames, { guildId: interaction.guild?.id });
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
      const evidenceRow = buildAutoCheckEvidenceRow(results);
      if (evidenceRow) components.push(evidenceRow);

      await interaction.editReply({ content: '', embeds: [embed], components });
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

  return {
    handleListCheckCommand,
    handleAutoCheckEvidenceSelect: createAutoCheckEvidenceHandler({ client }),
  };
}
