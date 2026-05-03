import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';

import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { resolveDisplayImageUrl } from '../../utils/imageRehost.js';

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
    return { emoji: '⛔', label: 'blacklist', color: COLORS.danger };
  }
  if (isWhiteEvidence) {
    return { emoji: '✅', label: 'whitelist', color: COLORS.success };
  }
  return { emoji: '⚠️', label: 'watchlist', color: COLORS.warning };
}

export function getFlaggedResultsWithImages(results) {
  return results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => pickEvidenceEntry(result));
}

export function buildSearchEvidenceComponents(flaggedWithImages) {
  if (flaggedWithImages.length === 0) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('search_evidence')
        .setPlaceholder('📎 View evidence for...')
        .addOptions(
          flaggedWithImages.slice(0, 25).map(({ result, index }) => {
            const evidenceEntry = pickEvidenceEntry(result);
            const style = getEvidenceStyle(result, evidenceEntry);
            return {
              label: result.name,
              description: (evidenceEntry.reason || 'No reason').slice(0, 100),
              value: String(index),
              emoji: style.emoji,
            };
          })
        )
    ),
  ];
}

export async function attachSearchEvidenceCollector({ interaction, results, flaggedWithImages }) {
  if (flaggedWithImages.length === 0) return;

  const reply = await interaction.fetchReply();
  const collector = reply.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 300000,
  });

  collector.on('collect', async (sel) => {
    if (sel.user.id !== interaction.user.id) {
      await sel.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Not Your Session',
          description: 'Only the command user can view evidence on this search.',
        })],
        ephemeral: true,
      });
      return;
    }

    const idx = parseInt(sel.values[0]);
    const result = results[idx];
    const entry = pickEvidenceEntry(result);

    if (!entryHasImage(entry)) {
      await sel.reply({ content: 'No evidence image for this entry.', ephemeral: true });
      return;
    }

    // Resolve fresh URL: rehosted entries get a freshly-signed URL via the
    // evidence channel; legacy entries fall back to their stored URL (which
    // may already have expired).
    const displayUrl = await resolveDisplayImageUrl(entry, interaction.client);
    if (!displayUrl) {
      await sel.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Evidence Unavailable',
          description: 'The evidence image link expired or the rehosted message was removed.',
          footer: 'Re-upload via /la-list edit name:<entry> image:<file>.',
        })],
        ephemeral: true,
      });
      return;
    }

    const style = getEvidenceStyle(result, entry);
    const evidenceEmbed = new EmbedBuilder()
      .setTitle(`${style.emoji} ${result.name}`)
      .addFields(
        { name: 'Reason', value: entry.reason || 'N/A', inline: true },
        { name: 'Raid', value: entry.raid || 'N/A', inline: true },
        { name: 'List', value: style.label, inline: true },
      )
      .setImage(displayUrl)
      .setColor(style.color)
      .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

    if (entry.logsUrl) {
      evidenceEmbed.addFields({ name: 'Logs', value: `[View Logs](${entry.logsUrl})`, inline: false });
    }

    await sel.reply({ embeds: [evidenceEmbed], ephemeral: true });
  });

  collector.on('end', async () => {
    await interaction.editReply({ components: [] }).catch(() => {});
  });
}
