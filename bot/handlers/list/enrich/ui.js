import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { getClassName } from '../../../models/Class.js';
import { LIST_LABELS } from './data.js';

export function buildEnrichPreviewReply({ entry, foundType, meta, newAlts, result, sessionId }) {
  const ctx = LIST_LABELS[foundType];
  const altLines = newAlts
    .map((alt, index) => {
      const cls = getClassName(alt.classId) || alt.classId || 'Unknown';
      const ilvl = typeof alt.itemLevel === 'number' ? alt.itemLevel.toFixed(2) : alt.itemLevel;
      return `**${index + 1}.** ${alt.name} · ${cls} · \`${ilvl}\``;
    })
    .join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${ctx.icon} Enrich preview — ${entry.name}`)
    .setDescription(
      `Stronghold scan in **${meta.guildName}** matched ${result.alts.length} alt(s). ` +
      `${newAlts.length} are not yet in this ${ctx.label} entry.\n\n${altLines}\n\n` +
      `Click **Confirm** to append all ${newAlts.length} to \`allCharacters\`, or **Cancel** to discard.`
    )
    .setColor(ctx.color)
    .setFooter({
      text:
        `Scanned ${result.scannedCandidates} candidates, ` +
        `${result.failedCandidates} failed · Session expires in 5 min`,
    });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`list-enrich:confirm:${sessionId}`)
      .setLabel(`Confirm Add ${newAlts.length}`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`list-enrich:cancel:${sessionId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: '',
    embeds: [embed],
    components: [row],
  };
}

export function buildEnrichSuccessEmbed(session, updateResult) {
  const ctx = LIST_LABELS[session.type];
  const altNames = session.newAlts.map((alt) => alt.name);
  return new EmbedBuilder()
    .setTitle(`${ctx.icon} Enriched ${session.entryName}`)
    .setDescription(
      `Appended ${altNames.length} alt(s) to ${ctx.label} entry's \`allCharacters\`:\n\n` +
      altNames.map((name, index) => `${index + 1}. ${name}`).join('\n')
    )
    .setColor(ctx.color)
    .setFooter({
      text: `matched=${updateResult.matchedCount} modified=${updateResult.modifiedCount}`,
    })
    .setTimestamp(new Date());
}
