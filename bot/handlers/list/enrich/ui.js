/**
 * enrich/ui.js
 *
 * Embed builders specific to the enrich flow. The progress embed wraps
 * the shared scan-progress layout with a list-type tint, and the
 * success card renders the post-confirm "appended N alts" outcome.
 *
 * The post-scan result/preview embed lives in `bot/utils/scanResultEmbed.js`
 * because /la-roster deep:true reuses the same layout. Anything that
 * needs to render the alt list with Continue / Save / Discard buttons
 * goes through that module.
 *
 * Voice is English-first Artist Kitsune (warm first-person, no em-dash,
 * no stage directions).
 */

import { LIST_LABELS } from './data.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { ICONS } from '../../../utils/ui.js';
import { buildScanProgressEmbed } from '../../../utils/scanProgressEmbed.js';

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

export function buildEnrichSuccessEmbed(session, updateResult) {
  const ctx = LIST_LABELS[session.type];
  const lines = session.newAlts
    .map((alt, index) => {
      const link = `https://lostark.bible/character/NA/${encodeURIComponent(alt.name)}/roster`;
      return `${index + 1}. [${alt.name}](${link})`;
    })
    .join('\n');

  return buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: ctx.icon,
    color: ctx.color,
    title: `Enriched · ${session.entryName}`,
    description:
      `Appended ${session.newAlts.length} alt(s) to the ${ctx.label} entry's ` +
      `\`allCharacters\`:\n\n${lines}`,
    footer: `matched=${updateResult.matchedCount} · modified=${updateResult.modifiedCount}`,
  });
}
