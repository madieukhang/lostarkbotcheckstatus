import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import config from '../../../config.js';
import RosterSnapshot from '../../../models/RosterSnapshot.js';
import UserPreference from '../../../models/UserPreference.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
  partitionListCheckResultsByVerification,
} from '../../../services/list-check/service.js';
import { didListCheckNameChange } from '../../../services/list-check/matchResolution.js';
import { createNameSuggestionContext } from '../../../services/roster/search.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editEmbed,
  editNotice,
} from '../../../utils/interactionReplies.js';
import { buildListCheckEmbed } from '../../../utils/listCheckEmbed.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { normalizeNameList } from '../../../utils/names.js';
import { ICONS } from '../../../utils/ui.js';
import { getUserLanguage, t, tPick } from '../../../services/i18n/index.js';
import {
  getListContext,
  decorateListEntry,
  parseListEntryRef,
} from '../helpers.js';
import { statMapFromRosterCharacters } from '../trackedAltsRender.js';
import { buildCheckEntryDetailsEmbed } from './ui.js';

function pickListEntryForDetails(result) {
  for (const [listType, entry] of [
    ['black', result.blackEntry],
    ['watch', result.watchEntry],
    ['white', result.whiteEntry],
  ]) {
    if (entry) {
      return { entry, listType };
    }
  }
  return null;
}

/**
 * Build the auto-check / /la-check details dropdown. Every result backed by
 * a blacklist, watchlist, or whitelist entry is selectable even when the
 * entry has no evidence image. Blacklist wins when one checked name happens
 * to match multiple lists, because it is the highest-severity result shown on
 * the check card. The legacy custom id is kept so already-rendered evidence
 * menus continue to work after deploy.
 */
export function buildAutoCheckEvidenceRow(results, lang = 'en') {
  const candidates = [];
  const seenEntryRefs = new Set();
  for (const result of results) {
    const picked = pickListEntryForDetails(result);
    if (!picked) continue;
    const entryRef = `${picked.listType}:${picked.entry._id}`;
    if (seenEntryRefs.has(entryRef)) continue;
    seenEntryRefs.add(entryRef);
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
      .setPlaceholder(`${ICONS.evidence} ${t('listView.navigation.detailsPlaceholder', lang)}`)
      .addOptions(
        candidates.slice(0, 25).map(({ result, entry, listType }) => {
          const ctx = getListContext(listType);
          const label = didListCheckNameChange(result)
            ? `${result.inputName} → ${result.name}`
            : String(result.name || result.inputName || 'Unknown');
          return {
            label: label.slice(0, 100),
            description: (entry.reason || t('listView.navigation.noReason', lang)).slice(0, 100),
            value: `${listType}:${entry._id}`.slice(0, 100),
            emoji: ctx.icon,
          };
        })
      )
  );
}

/**
 * Load cached character stats for the dropdown detail card. This path is
 * deliberately DB-only: the original check already owns enrichment, so a
 * component click must not trigger another Bible/worker request.
 */
export async function loadCheckDetailStatMap(entry, {
  RosterSnapshotModel = RosterSnapshot,
} = {}) {
  const names = normalizeNameList([
    entry?.name,
    ...(Array.isArray(entry?.allCharacters) ? entry.allCharacters : []),
  ]);
  if (names.length === 0) return new Map();

  try {
    const snapshots = await RosterSnapshotModel.find({ name: { $in: names } })
      .collation({ locale: 'en', strength: 2 })
      .lean();
    return statMapFromRosterCharacters(snapshots);
  } catch (err) {
    console.warn('[listcheck] Snapshot lookup for detail card failed (non-fatal):', err.message);
    return new Map();
  }
}

function createAutoCheckEvidenceHandler({ client }) {
  return async function handleAutoCheckEvidenceSelect(interaction) {
    const raw = interaction.values?.[0] || '';
    const parsed = parseListEntryRef(raw);
    await deferReply(interaction, { ephemeral: true });
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    if (!parsed) {
      await editNotice(interaction, t('dialogue.check.malformed', lang), {
        severity: AlertSeverity.WARNING,
        lang,
      });
      return;
    }

    await connectDB();
    const ctx = getListContext(parsed.listType);
    const entry = await ctx.model.findOne({ _id: parsed.id }).lean();

    if (!entry) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.check.entryRemoved', lang),
        lang,
      });
      return;
    }

    const decorated = decorateListEntry(entry, parsed.listType);
    const [displayUrl, statMap] = await Promise.all([
      resolveDisplayImageUrl(entry, client),
      loadCheckDetailStatMap(entry),
    ]);
    const isOfficer =
      config.officerApproverIds.includes(interaction.user.id)
      || config.seniorApproverIds.includes(interaction.user.id);

    await editEmbed(interaction, buildCheckEntryDetailsEmbed(decorated, {
      displayUrl,
      includeAddedBy: isOfficer,
      lang,
      statMap,
    }));
  };
}

export function createCheckHandlers({ client }) {
  async function handleListCheckCommand(interaction) {
    // Started before the defer so the figure on the card matches the wait
    // the user actually sat through.
    const startedAt = Date.now();
    const image = interaction.options.getAttachment('image', true);
    let names;
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
      `🔍 ${tPick('dialogue.check.progress', lang, { count: limitedNames.length, word: t(`dialogue.check.${limitedNames.length === 1 ? 'nameOne' : 'nameMany'}`, lang) })}`,
      limitedNames.length < names.length ? t('dialogue.check.ignored', lang, { count: names.length - limitedNames.length, word: t(`dialogue.check.${names.length - limitedNames.length === 1 ? 'nameOne' : 'nameMany'}`, lang), limit: maxNames }) : null,
    ].filter(Boolean).join('\n'), {
      severity: AlertSeverity.INFO,
      titleIcon: '🔍',
      lang,
    });

    try {
      const checkedResults = await checkNamesAgainstLists(limitedNames, {
        guildId: interaction.guild?.id,
        inputSource: 'ocr',
        suggestionCache,
        suggestionContext,
      });
      const { verified: results, unverified } = partitionListCheckResultsByVerification(
        checkedResults
      );
      if (results.length === 0) {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          ...t('dialogue.check.noVerifiedNames', lang, { count: unverified.length }),
          lang,
        });
        return;
      }
      const formattedLines = formatCheckResults(results, lang);

      const { embed } = buildListCheckEmbed({
        results,
        formattedLines,
        limitedNamesCount: limitedNames.length,
        ignoredCount: names.length - limitedNames.length,
        unverifiedCount: unverified.length,
        maxNames,
        mode: 'slash',
        lang,
        elapsedMs: Date.now() - startedAt,
      });

      // Details dropdown · unlike /la-list view's image-only evidence row,
      // this surfaces every list hit so raid / reason / added-by metadata is
      // still reachable when no screenshot was attached to the entry.
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
