import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
} from 'discord.js';

import config from '../../config.js';
import { ICONS } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed, editNotice, editPayload, replyAlert } from '../../utils/interactionReplies.js';
import { buildScopedListQuery } from '../../utils/scope.js';
import { resetSelectMenu } from '../../utils/selectMenu.js';
import { resolveDisplayImageUrl } from '../../utils/imageRehost.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { decorateListEntry, getListContext } from '../list/helpers.js';
import { loadCheckDetailStatMap } from '../list/check/index.js';
import { buildCheckEntryDetailsEmbed } from '../list/check/ui.js';

/** Detect whether an entry has any image evidence (rehosted OR legacy). */
function entryHasImage(entry) {
  return Boolean(entry?.imageMessageId || entry?.imageUrl);
}

/** Show an attachment marker only for the report opened by the details menu. */
export function pickEvidenceEntry(result) {
  const entry = pickSearchDetailEntry(result)?.entry;
  return entryHasImage(entry) ? entry : null;
}

/** Select the report shown by the result's severity icon, regardless of images. */
export function pickSearchDetailEntry(result) {
  for (const listType of ['black', 'watch', 'white']) {
    if (result?.[listType]) return { entry: result[listType], listType };
  }
  return null;
}

/** Retain search order and separate aliases while collecting report details. */
export function getSearchDetailResults(results) {
  return results.flatMap((result, index) => {
    const detail = pickSearchDetailEntry(result);
    return detail ? [{ result, index, ...detail }] : [];
  });
}

/** Build the same no-image-required details menu offered by text/image checks. */
export function buildSearchDetailComponents(detailResults, lang = 'en') {
  if (detailResults.length === 0) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('search_evidence')
        .setPlaceholder(`${ICONS.evidence} ${t('listView.navigation.detailsPlaceholder', lang)}`)
        .addOptions(
          detailResults.slice(0, 24).map(({ result, index, entry, listType }) => {
            return {
              label: result.name.slice(0, 100),
              description: (entry.reason || t('listView.navigation.noReason', lang)).slice(0, 100),
              value: String(index),
              emoji: getListContext(listType).icon,
            };
          })
        )
        .addOptions({ label: t('listView.navigation.selectNone', lang), value: 'none', emoji: '↩️' })
    ),
  ];
}

/** Reload the selected entry and recheck blacklist visibility at click time. */
export async function loadSearchDetailEntry({ entry, listType }, guildId, {
  getContext = getListContext,
} = {}) {
  if (!entry?._id) return null;
  return getContext(listType).model.findOne(
    buildScopedListQuery(listType, { _id: entry._id }, guildId)
  ).lean();
}

/** Create an owner-only detail interaction with injectable read-only I/O. */
export function createSearchDetailSelectHandler({
  interaction,
  detailResults,
  lang = 'en',
  loadEntry = loadSearchDetailEntry,
  loadStatMap = loadCheckDetailStatMap,
  resolveImageUrl = resolveDisplayImageUrl,
  getLanguage = getUserLanguage,
}) {
  return async (sel) => {
    if (sel.user.id !== interaction.user.id) {
      const clickerLang = await getLanguage(sel.user.id, { UserPreferenceModel: UserPreference });
      await replyAlert(sel, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.search.session', clickerLang),
        lang: clickerLang,
      });
      return;
    }

    if (sel.values?.[0] === 'none') {
      await resetSelectMenu(sel, 'search_evidence');
      return;
    }

    // Acknowledge before reading Mongo or resolving an attachment URL. The
    // legacy numeric value still addresses the original search result order.
    await deferReply(sel, { ephemeral: true });
    const detail = detailResults.find(({ index }) => String(index) === sel.values?.[0]);
    if (!detail) {
      await editNotice(sel, t('dialogue.check.malformed', lang), {
        severity: AlertSeverity.WARNING,
        lang,
      });
      return;
    }

    try {
      const entry = await loadEntry(detail, interaction.guild?.id || interaction.guildId || '');
      if (!entry) {
        await editAlert(sel, {
          severity: AlertSeverity.WARNING,
          ...t('dialogue.check.entryRemoved', lang),
          lang,
        });
        return;
      }

      const [displayUrl, statMap] = await Promise.all([
        entryHasImage(entry) ? resolveImageUrl(entry, interaction.client) : '',
        loadStatMap(entry),
      ]);
      const includeAddedBy = config.officerApproverIds.includes(sel.user.id)
        || config.seniorApproverIds.includes(sel.user.id);
      // Preserve the stored primary name: the selected result may be its alt.
      // An absent/expired image must never hide the report's text and roster.
      await editEmbed(sel, buildCheckEntryDetailsEmbed(decorateListEntry(entry, detail.listType), {
        displayUrl,
        statMap,
        includeAddedBy,
        lang,
      }));
    } catch (err) {
      console.warn('[search] Detail lookup failed:', err.message);
      await editAlert(sel, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.search.failed', lang),
        lang,
      });
    }
  };
}

/** Attach the per-search details session without changing the parent result card. */
export async function attachSearchDetailCollector({ interaction, detailResults, lang = 'en' }) {
  if (detailResults.length === 0) return;
  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 300000,
  });
  collector.on('collect', createSearchDetailSelectHandler({ interaction, detailResults, lang }));
  collector.on('end', async () => {
    await editPayload(interaction, { components: [] }).catch(() => {});
  });
}
