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
 * Public wording is localization-owned and uses first-person copy without
 * stage directions. English is the fallback locale.
 */

import { LIST_LABELS } from './data.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { ICONS } from '../../../utils/ui.js';
import { buildScanProgressEmbed } from '../../../utils/scanProgressEmbed.js';
import { getClassName } from '../../../models/Class.js';
import { formatAltLine } from '../trackedAltsRender.js';
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
 * alt(s) to the entry's `allCharacters`" with a layout containing per-alt
 * class and item level, scan source, hidden-roster state, and a next-step
 * hint. Database counters such as `matched=1 · modified=1` are written to
 * debug logs rather than the public footer.
 *
 * Layout:
 *   ${list-icon} Saved · ${entry.name}        (color: list-type tint)
 *
 *   ✨ Localized confirmation with the appended-alt count.
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

  // Rendered through the shared alt-row formatter rather than a local
  // copy · this card used to hand-roll the same line and so missed every
  // later change to it (the CP badge, for one). alt.classId may already
  // be a resolved className or a raw bible-side id ("deathblade"), so the
  // record is normalised to the shape formatAltLine expects.
  const altLines = session.newAlts
    .map((alt, index) => {
      const idStr = alt.classId == null ? '' : String(alt.classId);
      const className = alt.className || getClassName(idStr) || idStr;
      return formatAltLine(alt.name, index, { ...alt, className });
    })
    .join('\n');

  const contextLines = [
    session.scanStats?.guildName
      ? `📍 ${t('dialogue.enrich.success.source', lang, { guild: session.scanStats.guildName })}`
      : '',
    session.targetIsHidden
      ? `${ICONS.locked} ${t('dialogue.enrich.success.hidden', lang)}`
      : '',
  ].filter(Boolean);

  // Sections are declared in display order and empty optional blocks drop out
  // in one place, instead of mutating the array through several adjacent ifs.
  const sections = [
    `${ICONS.fox || '✨'} ${t('dialogue.enrich.success.appended', lang, { count: session.newAlts.length, list: t(`dialogue.broadcast.list.${session.type}`, lang) })}`,
    contextLines.join('\n'),
    altLines ? `**🆕 ${t('dialogue.enrich.success.newlyTracked', lang)}**\n${altLines}` : '',
    `💡 ${t('dialogue.enrich.success.tip', lang, { type: session.type })}`,
  ].filter(Boolean);

  // Server-side trace for cases where confirmation appears not to persist.
  // matched/modified counters remain in logs because they are operational
  // details rather than public status information.
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
