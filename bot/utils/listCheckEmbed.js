/**
 * listCheckEmbed.js
 *
 * Shared embed + footer builder for OCR-driven list checks. Both
 * `/la-list check` (slash command) and `handlers/list/auto-check.js` (passive
 * auto-check on image post) call this so the two surfaces stay in
 * visual sync.
 *
 * Layout:
 *   [state-driven title icon] List Check · N name(s)
 *   [breakdown line]   ⛔ 3 · ⚠️ 1 · ❓ 5 not listed
 *   [per-name list]    ⛔ Name · reason · [raid]
 *                      ⚠️ Name · reason
 *                      ❓ Name
 *                      ❓ Name
 *   [stats fields]     🔍 Checked · 🚨 Flagged · ✅ Cleared (3-up inline)
 *   [footer]           Tip line + source citation
 *
 * Color follows the strongest outcome present:
 *   any blacklist hit → red,  any watch → yellow,
 *   else has white/trusted → green,  else blurple (no flags but
 *   nothing to celebrate).
 */

import { createArtistEmbed } from './artistVoice.js';

/**
 * @typedef ListCheckRender
 * @property {EmbedBuilder} embed
 * @property {{black:number, watch:number, white:number, trusted:number, notListed:number}} counts
 */

/**
 * @param {Object} options
 * @param {Array<object>} options.results - Output from checkNamesAgainstLists
 * @param {Array<string>} options.formattedLines - Output from formatCheckResults (display lines, sorted by priority)
 * @param {number} options.limitedNamesCount - Number of names actually checked
 * @param {number} [options.ignoredCount=0] - Names dropped by per-message cap
 * @param {number} [options.maxNames] - The cap value, used in the "ignored" note
 * @param {'slash'|'auto'} [options.mode='slash'] - Drives small copy differences (title verb, footer)
 * @returns {ListCheckRender}
 */
export function buildListCheckEmbed({
  results,
  formattedLines,
  limitedNamesCount,
  ignoredCount = 0,
  maxNames,
  mode = 'slash',
}) {
  // Per-category counts. Mirrors the priority logic in formatCheckResults
  // so the badge counts and the line-list categorisation never drift.
  const counts = {
    black: 0,
    watch: 0,
    white: 0,
    trusted: 0,
    notListed: 0,
  };
  for (const r of results) {
    if (r.blackEntry) counts.black++;
    else if (r.watchEntry) counts.watch++;
    else if (r.whiteEntry) counts.white++;
    else if (r.trustedEntry) counts.trusted++;
    else counts.notListed++;
  }

  const flaggedCount = counts.black + counts.watch;
  const clearedCount = counts.white + counts.trusted + counts.notListed;

  let color;
  let titleIcon;
  if (counts.black > 0) { color = 0xed4245; titleIcon = '⛔'; }
  else if (counts.watch > 0) { color = 0xfee75c; titleIcon = '⚠️'; }
  else if (counts.white > 0 || counts.trusted > 0) { color = 0x57f287; titleIcon = '✅'; }
  else { color = 0x5865f2; titleIcon = '🔍'; }

  // HUD-merged header. The mode + total name count live on the author kicker
  // line; the title IS the breakdown, ordered by severity (black -> watch ->
  // white -> trusted -> notListed). Plain text (embed titles ignore markdown)
  // so the title's leading emoji is naturally the strongest outcome present -
  // no separate "Outcome:" line and no redundant count line needed.
  const titlePrefix = mode === 'auto' ? 'AUTO-CHECK' : 'LIST CHECK';
  const kicker = `// ${titlePrefix} · ${limitedNamesCount} NAMES`;

  const breakdownParts = [];
  if (counts.black) breakdownParts.push(`⛔ ${counts.black}`);
  if (counts.watch) breakdownParts.push(`⚠️ ${counts.watch}`);
  if (counts.white) breakdownParts.push(`✅ ${counts.white}`);
  if (counts.trusted) breakdownParts.push(`🛡️ ${counts.trusted}`);
  if (counts.notListed) breakdownParts.push(`❓ ${counts.notListed} not listed`);
  // breakdown is empty only with zero results -> fall back to a plain count.
  const title = breakdownParts.length > 0
    ? breakdownParts.join(' · ')
    : `${titleIcon} ${limitedNamesCount} name(s)`;

  const ignoreNote = ignoredCount > 0
    ? `\n\n*Ignored ${ignoredCount} extra name(s) (cap: ${maxNames ?? 'configured'}).*`
    : '';

  // Description leads straight with the per-name list now (the breakdown moved
  // up into the title). Ceiling is 4096; the slice is a safety net for long
  // reasons / many similar-name suggestions.
  const description = (`${formattedLines.join('\n')}${ignoreNote}`).slice(0, 4096);

  // Stats grid (Checked / Flagged / Cleared) was a 3-up inline field
  // panel pre-v0.5.73. The Outcome breakdown line at the top of the
  // description carries the same per-status info (with finer
  // granularity), so the panel was strictly redundant and made the
  // card feel busy. Dropped intentionally; reintroduce only if
  // someone needs the aggregate counts in a separate visual block.
  // (clearedCount kept above as a value reference for future copy
  // tweaks but not surfaced in fields.)
  void clearedCount;

  // Footer hint differs between modes:
  //   slash:  Tip toward /la-roster on a flagged hit OR retry hint when unflagged.
  //   auto:   Note that the dropdown below lets you Quick Add unflagged
  //           names (the auto-check pipeline ships a select menu for that).
  // Footer is a HUD status line: a // FLAGGED n (or // CLEAR) tag, the
  // mode-specific tip, then the source citation.
  const footerParts = [flaggedCount > 0 ? `// FLAGGED ${flaggedCount}` : '// CLEAR'];
  if (mode === 'auto') {
    if (flaggedCount > 0) {
      footerParts.push('Quick Add unflagged via the dropdown · /la-roster <name> for detail');
    } else if (counts.notListed > 0) {
      footerParts.push('Quick Add unflagged names via the dropdown below');
    }
  } else if (flaggedCount > 0) {
    footerParts.push('/la-roster <name> for the full roster of any flagged hit');
  } else {
    footerParts.push('Re-run with a fresh image to re-check');
  }
  footerParts.push('SRC db blacklist + whitelist + watchlist + trusted');

  const embed = createArtistEmbed()
    .setAuthor({ name: kicker })
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  return { embed, counts };
}
