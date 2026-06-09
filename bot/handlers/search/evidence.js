import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
} from 'discord.js';

import { COLORS, ICONS } from '../../utils/ui.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { editPayload, replyAlert, replyContent, replyEmbed } from '../../utils/interactionReplies.js';
import { resolveDisplayImageUrl } from '../../utils/imageRehost.js';
import { t } from '../../services/i18n/index.js';
import { buildEvidenceEmbed } from '../list/view/ui.js';

/** Detect whether an entry has any image evidence (rehosted OR legacy). */
export function entryHasImage(entry) {
  return Boolean(entry?.imageMessageId || entry?.imageUrl);
}

export function pickEvidenceEntry(result) {
  if (entryHasImage(result?.black)) return result.black;
  if (entryHasImage(result?.white)) return result.white;
  if (entryHasImage(result?.watch)) return result.watch;
  return null;
}

function getEvidenceStyle(result, entry) {
  const isBlackEvidence = entry === result?.black;
  const isWhiteEvidence = entry === result?.white;

  if (isBlackEvidence) {
    return { emoji: '⛔', label: 'blacklist', color: COLORS.danger, type: 'black' };
  }
  if (isWhiteEvidence) {
    return { emoji: '✅', label: 'whitelist', color: COLORS.success, type: 'white' };
  }
  return { emoji: '⚠️', label: 'watchlist', color: COLORS.warning, type: 'watch' };
}

export function getFlaggedResultsWithImages(results) {
  return results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => pickEvidenceEntry(result));
}

export function buildSearchEvidenceComponents(flaggedWithImages, lang = 'en') {
  if (flaggedWithImages.length === 0) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('search_evidence')
        .setPlaceholder(`${ICONS.evidence} ${t('listView.navigation.evidencePlaceholder', lang)}`)
        .addOptions(
          flaggedWithImages.slice(0, 25).map(({ result, index }) => {
            const evidenceEntry = pickEvidenceEntry(result);
            const style = getEvidenceStyle(result, evidenceEntry);
            return {
              label: result.name,
              description: (evidenceEntry.reason || t('listView.navigation.noReason', lang)).slice(0, 100),
              value: String(index),
              emoji: style.emoji,
            };
          })
        )
    ),
  ];
}

export async function attachSearchEvidenceCollector({ interaction, results, flaggedWithImages, lang = 'en' }) {
  if (flaggedWithImages.length === 0) return;

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 300000,
  });

  collector.on('collect', async (sel) => {
    if (sel.user.id !== interaction.user.id) {
      await replyAlert(sel, {
        severity: AlertSeverity.ERROR,
        title: 'Not Your Session',
        description: 'Only the command user can view evidence on this search.',
      });
      return;
    }

    const idx = parseInt(sel.values[0]);
    const result = results[idx];
    const entry = pickEvidenceEntry(result);

    if (!entryHasImage(entry)) {
      await replyContent(sel, t('listView.evidence.noImage', lang));
      return;
    }

    // Resolve fresh URL: rehosted entries get a freshly-signed URL via the
    // evidence channel; legacy entries fall back to their stored URL (which
    // may already have expired).
    const displayUrl = await resolveDisplayImageUrl(entry, interaction.client);
    if (!displayUrl) {
      await replyAlert(sel, {
        severity: AlertSeverity.WARNING,
        title: 'Evidence Unavailable',
        description: 'The evidence image link expired or the rehosted message was removed.',
        footer: 'Re-upload via /la-list edit name:<entry> image:<file>.',
      });
      return;
    }

    // Decorate the entry with the visual tokens that buildEvidenceEmbed
    // expects (it shares those tokens with /la-list view's renderer).
    // The search-result envelope holds the raw Mongoose doc on `entry`,
    // so the search-result name (which may match via roster, not entry
    // name) is layered on top so the title reads as the searched name.
    const style = getEvidenceStyle(result, entry);
    const decoratedEntry = {
      ...entry,
      name: result.name,
      _listType: style.type,
      _icon: style.emoji,
      _label: style.label,
      _color: style.color,
    };
    const evidenceEmbed = buildEvidenceEmbed(decoratedEntry, displayUrl, { lang });
    await replyEmbed(sel, evidenceEmbed);
  });

  collector.on('end', async () => {
    await editPayload(interaction, { components: [] }).catch(() => {});
  });
}
