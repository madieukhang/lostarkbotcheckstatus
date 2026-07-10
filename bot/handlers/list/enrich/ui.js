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
import { rosterUrl } from '../../../utils/rosterLink.js';
import { ICONS } from '../../../utils/ui.js';
import { buildScanProgressEmbed } from '../../../utils/scanProgressEmbed.js';
import { getClassName, getClassEmoji } from '../../../models/Class.js';
import { t } from '../../../services/i18n/index.js';

/**
 * Enrich-flavoured wrapper around `buildScanProgressEmbed`. Carries the
 * list-type icon + color so blacklist/whitelist/watchlist enrichments
 * stay visually consistent with the rest of the alert family while
 * sharing the generic progress-bar layout with `/la-roster deep:true`.
 */
export function buildEnrichProgressEmbed({ entry, foundType, meta, progress, lang = 'en' }) {
  const ctx = LIST_LABELS[foundType];
  return buildScanProgressEmbed({
    title: t('dialogue.scan.progress', lang, { name: entry.name }),
    subtitle: progress.totalMembers
      ? t('dialogue.scan.guildMembers', lang, { guild: meta.guildName, count: progress.totalMembers })
      : t('dialogue.scan.guild', lang, { guild: meta.guildName }),
    color: ctx.color,
    titleIcon: ICONS.search,
    progress,
    lang,
  });
}

/**
 * Post-confirm success card. Replaces the older one-line "Appended N
 * alt(s) to the entry's `allCharacters`" with a richer layout that
 * surfaces the per-alt class + ilvl (data we already had on the
 * session but threw away), the scan source (guild + hidden-roster
 * indicator), and a next-step hint pointing at /la-list view. The
 * Mongoose-ese footer (`matched=1 · modified=1`) is replaced with a
 * user-friendly footer; the technical numbers go into a debug log
 * server-side instead of polluting the end-user view.
 *
 * Layout:
 *   ${list-icon} Saved · ${entry.name}        (color: list-type tint)
 *
 *   ✨ I appended **5 new alt(s)** to the blacklist entry.
 *   📍 Source: Stronghold scan in **<guild>**
 *   🔒 Roster was hidden, matched via stronghold fingerprint  [optional]
 *
 *   **🆕 Newly tracked characters:**
 *   1. [Name](link) · Class · `1750.83`
 *   2. [Name](link) · Class · `1740.00`
 *   ...
 *
 *   💡 Tip: /la-list view <type> to browse the full list.
 */
export function buildEnrichSuccessEmbed(session, updateResult, lang = 'en') {
  const ctx = LIST_LABELS[session.type];

  // Per-alt rendering: bring back class + ilvl that the success card
  // dropped before. Names link out to bible roster page so an officer
  // skimming the card can audit a specific match in one click.
  const altLines = session.newAlts
    .map((alt, index) => {
      // alt.classId may already be a resolved className (e.g. from
      // older alt records) or a raw bible-side id ("deathblade",
      // "warlord"). Try the known-id lookup first; fall back to
      // string-stringify so non-string ids don't crash getClassName.
      const idStr = alt.classId == null ? '' : String(alt.classId);
      const cls = alt.className || getClassName(idStr) || idStr || t('dialogue.enrich.success.unknown', lang);
      const classPrefix = getClassEmoji(cls) || cls;
      const ilvl = typeof alt.itemLevel === 'number'
        ? alt.itemLevel.toFixed(2)
        : (alt.itemLevel || '?');
      const link = rosterUrl(alt.name);
      return `**${index + 1}.** ${classPrefix} [${alt.name}](${link}) · \`${ilvl}\``;
    })
    .join('\n');

  // Sections joined by blank lines. Each section is one visual block;
  // the blank line between them gives Discord enough breathing room
  // to render distinct units instead of a wall of text.
  const sections = [];

  sections.push(
    `${ICONS.fox || '✨'} ${t('dialogue.enrich.success.appended', lang, { count: session.newAlts.length, list: t(`dialogue.broadcast.list.${session.type}`, lang) })}`
  );

  const contextLines = [];
  if (session.scanStats?.guildName) {
    contextLines.push(`📍 ${t('dialogue.enrich.success.source', lang, { guild: session.scanStats.guildName })}`);
  }
  if (session.targetIsHidden) {
    contextLines.push(`${ICONS.locked} ${t('dialogue.enrich.success.hidden', lang)}`);
  }
  if (contextLines.length > 0) sections.push(contextLines.join('\n'));

  if (altLines) {
    sections.push(`**🆕 ${t('dialogue.enrich.success.newlyTracked', lang)}**\n${altLines}`);
  }

  sections.push(`💡 ${t('dialogue.enrich.success.tip', lang, { type: session.type })}`);

  // Server-side trace for the Mongoose write outcome. Useful when
  // diagnosing "I clicked Confirm but nothing seemed to save"; surfacing
  // matched/modified to end users was confusing more than informative.
  if (updateResult && (updateResult.matchedCount === 0 || updateResult.modifiedCount === 0)) {
    console.warn(
      `[enrich] Confirm wrote unexpectedly empty result for ${session.entryName}: ` +
      `matched=${updateResult.matchedCount}, modified=${updateResult.modifiedCount}`
    );
  }

  return buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: ctx.icon,
    color: ctx.color,
    title: t('dialogue.enrich.success.title', lang, { name: session.entryName }),
    description: sections.join('\n\n'),
    footer: t('dialogue.enrich.success.footer', lang),
    lang,
  });
}
