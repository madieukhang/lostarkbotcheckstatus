/**
 * enrich/ui.js
 *
 * Embed + component builders for the /la-list enrich confirm dialog
 * and the post-confirm success card. First migration target for the
 * RaidManage-inspired UI rework: pulls icons/colors from `bot/utils/ui.js`,
 * uses Discord native timestamps via the session-footer helper, and
 * delegates layout to `buildAlertEmbed`. Voice is English-first Artist
 * Kitsune (warm first-person, no em-dash, no stage directions).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { getClassName } from '../../../models/Class.js';
import { LIST_LABELS } from './data.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { ICONS, buildSessionFooter } from '../../../utils/ui.js';
import { buildScanProgressEmbed } from '../../../utils/scanProgressEmbed.js';

const ENRICH_SESSION_MINUTES = 5;

/**
 * Enrich-flavoured wrapper around `buildScanProgressEmbed`. Carries the
 * list-type icon + color so blacklist/whitelist/watchlist enrichments
 * stay visually consistent with the rest of the alert family while
 * sharing the generic progress-bar layout with `/la-roster deep:true`.
 */
export function buildEnrichProgressEmbed({ entry, foundType, meta, progress }) {
  const ctx = LIST_LABELS[foundType];
  return buildScanProgressEmbed({
    title: `Stronghold scan in progress · ${entry.name}`,
    subtitle: `Guild **${meta.guildName}**` +
      (progress.totalMembers ? ` (${progress.totalMembers} members)` : ''),
    color: ctx.color,
    titleIcon: ICONS.search,
    progress,
  });
}

export function buildEnrichPreviewReply({ entry, foundType, meta, newAlts, result, sessionId }) {
  const ctx = LIST_LABELS[foundType];
  const altLines = newAlts
    .map((alt, index) => {
      const cls = getClassName(alt.classId) || alt.classId || 'Unknown';
      const ilvl = typeof alt.itemLevel === 'number' ? alt.itemLevel.toFixed(2) : alt.itemLevel;
      return `**${index + 1}.** ${alt.name} · ${cls} · \`${ilvl}\``;
    })
    .join('\n');

  const embed = buildAlertEmbed({
    severity: AlertSeverity.INFO,
    titleIcon: ICONS.search,
    color: ctx.color,
    title: `Enrich preview · ${entry.name}`,
    description:
      `I scanned the stronghold in **${meta.guildName}** and matched ` +
      `${result.alts.length} alt(s). **${newAlts.length}** of them ` +
      `aren't on this ${ctx.label} entry yet:\n\n${altLines}\n\n` +
      `Hit **Confirm** and I'll append all ${newAlts.length} to ` +
      `\`allCharacters\`. **Cancel** drops them.`,
    footer:
      `Scanned ${result.scannedCandidates} candidates · ` +
      `${result.failedCandidates} failed · ` +
      buildSessionFooter(ENRICH_SESSION_MINUTES, 'only you can act'),
    timestamp: false,
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
  const lines = altNames.map((name, index) => `${index + 1}. ${name}`).join('\n');

  return buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: ctx.icon,
    color: ctx.color,
    title: `Enriched · ${session.entryName}`,
    description:
      `Appended ${altNames.length} alt(s) to the ${ctx.label} entry's ` +
      `\`allCharacters\`:\n\n${lines}`,
    footer: `matched=${updateResult.matchedCount} · modified=${updateResult.modifiedCount}`,
  });
}
