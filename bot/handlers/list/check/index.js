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
import { createNameSuggestionContext } from '../../../services/roster/search.js';
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
  editEmbed,
  editNotice,
  replyAlert,
  replyEmbed,
  replyNotice,
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
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    if (!parsed) {
      await replyNotice(interaction, t('dialogue.check.malformed', lang), {
        severity: AlertSeverity.WARNING,
        lang,
      });
      return;
    }

    await connectDB();
    const ctx = getListContext(parsed.listType);
    const entry = await ctx.model.findOne({ _id: parsed.id }).lean();

    if (!entry) {
      await replyAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.check.entryRemoved', lang),
        lang,
      });
      return;
    }

    if (!entry.imageMessageId && !entry.imageUrl) {
      await replyNotice(interaction, t('listView.evidence.noImage', lang), {
        severity: AlertSeverity.WARNING,
        lang,
      });
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
    const suggestionContext = createNameSuggestionContext({
      maxNetworkLookups: config.listcheckSuggestionLookupBudget,
    });
    const suggestionCache = suggestionContext.cache;

    await deferReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    try {
      names = await extractNamesFromImage(image, {
        refineAmbiguousDiacritics: true,
        suggestionCache,
        suggestionContext,
      });
    } catch (err) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.check.ocrFailed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
      return;
    }

    if (names.length === 0) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.check.noNames', lang),
        lang,
      });
      return;
    }

    const maxNames = config.listcheckMaxNames;
    const limitedNames = names.slice(0, maxNames);
    await editNotice(interaction, [
      `🔍 ${t('dialogue.check.progress', lang, { count: limitedNames.length, word: t(`dialogue.check.${limitedNames.length === 1 ? 'nameOne' : 'nameMany'}`, lang) })}`,
      limitedNames.length < names.length ? t('dialogue.check.ignored', lang, { count: names.length - limitedNames.length, word: t(`dialogue.check.${names.length - limitedNames.length === 1 ? 'nameOne' : 'nameMany'}`, lang), limit: maxNames }) : null,
    ].filter(Boolean).join('\n'), {
      severity: AlertSeverity.INFO,
      titleIcon: '🔍',
      lang,
    });

    try {
      const results = await checkNamesAgainstLists(limitedNames, {
        guildId: interaction.guild?.id,
        suggestionCache,
        suggestionContext,
      });
      const formattedLines = formatCheckResults(results, lang);

      const { embed } = buildListCheckEmbed({
        results,
        formattedLines,
        limitedNamesCount: limitedNames.length,
        ignoredCount: names.length - limitedNames.length,
        maxNames,
        mode: 'slash',
        lang,
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
        ...t('dialogue.check.failed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
    }
  }

  return {
    handleListCheckCommand,
    handleAutoCheckEvidenceSelect: createAutoCheckEvidenceHandler({ client }),
  };
}
