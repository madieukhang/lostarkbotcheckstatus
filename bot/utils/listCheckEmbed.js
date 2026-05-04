/**
 * listCheckEmbed.js
 *
 * Shared embed + footer builder for OCR-driven list checks. Both
 * `/la-list check` (slash command) and `autoCheckHandler.js` (passive
 * auto-check on image post) call this so the two surfaces stay in
 * visual sync.
 *
 * Layout:
 *   [state-driven title icon] List Check · N name(s)
 *   [breakdown line]   ⛔ 3 · ⚠️ 1 · ❓ 5 clean
 *   [per-name list]    ⛔ Name · reason · [raid]
 *                      ⚠️ Name · reason
 *                      ❓ Name
 *                      ⚪ Name *(no roster)*
 *   [stats fields]     🔍 Checked · 🚨 Flagged · ✅ Cleared (3-up inline)
 *   [footer]           Tip line + source citation
 *
 * Color follows the strongest outcome present:
 *   any blacklist hit → red,  any watch → yellow,
 *   else has white/trusted/clean → green,  else blurple (no flags but
 *   nothing to celebrate).
 */

import { EmbedBuilder } from 'discord.js';

/**
 * @typedef ListCheckRender
 * @property {EmbedBuilder} embed
 * @property {{black:number, watch:number, white:number, trusted:number, clean:number, noRoster:number}} counts
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
  const counts = { black: 0, watch: 0, white: 0, trusted: 0, clean: 0, noRoster: 0 };
  for (const r of results) {
    if (r.blackEntry) counts.black++;
    else if (r.watchEntry) counts.watch++;
    else if (r.whiteEntry) counts.white++;
    else if (r.trustedEntry) counts.trusted++;
    else if (r.hasRoster) counts.clean++;
    else counts.noRoster++;
  }

  const flaggedCount = counts.black + counts.watch;
  const clearedCount = counts.white + counts.trusted + counts.clean;

  let color;
  let titleIcon;
  if (counts.black > 0) { color = 0xed4245; titleIcon = '⛔'; }
  else if (counts.watch > 0) { color = 0xfee75c; titleIcon = '⚠️'; }
  else if (counts.white > 0 || counts.trusted > 0) { color = 0x57f287; titleIcon = '✅'; }
  else { color = 0x5865f2; titleIcon = '🔍'; }

  // Title verb differs between modes:
  //   slash command: "List Check" (active, just-ran-the-command)
  //   auto-check:    "Auto-check" (passive, fired on image post)
  const titlePrefix = mode === 'auto' ? 'Auto-check' : 'List Check';
  const title = `${titleIcon} ${titlePrefix} · ${limitedNamesCount} name(s)`;

  // Breakdown line at the top of the description gives the punchline
  // before the per-name list. Bolded counts anchor the eye when reading
  // a long batch; falsy buckets are dropped silently so a clean run
  // doesn't show empty separators.
  const summaryParts = [];
  if (counts.black) summaryParts.push(`⛔ **${counts.black}**`);
  if (counts.watch) summaryParts.push(`⚠️ **${counts.watch}**`);
  if (counts.white) summaryParts.push(`✅ **${counts.white}**`);
  if (counts.trusted) summaryParts.push(`🛡️ **${counts.trusted}**`);
  if (counts.clean) summaryParts.push(`❓ **${counts.clean}** clean`);
  if (counts.noRoster) summaryParts.push(`⚪ **${counts.noRoster}** no roster`);

  const headerLine = summaryParts.length > 0
    ? `**Outcome:** ${summaryParts.join(' · ')}`
    : `Scanned **${limitedNamesCount}** name(s) against the lists.`;

  const ignoreNote = ignoredCount > 0
    ? `\n*Ignored ${ignoredCount} extra name(s) (cap: ${maxNames ?? 'configured'}).*`
    : '';

  // Description ceiling is 4096; for typical OCR runs (8 names auto,
  // ~30 slash) the joined lines come in well under that. The slice is
  // a safety net for long reasons or many similar-name suggestions.
  const description = (`${headerLine}${ignoreNote}\n\n${formattedLines.join('\n')}`).slice(0, 4096);

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
  //   slash:  Tip toward /la-roster on a flagged hit OR retry hint when clean.
  //   auto:   Note that the dropdown below lets you Quick Add unflagged
  //           names (the auto-check pipeline ships a select menu for that).
  const footerParts = [];
  if (mode === 'auto') {
    if (flaggedCount > 0) {
      footerParts.push('Use the dropdown to Quick Add unflagged names · /la-roster <name> for full detail.');
    } else if (counts.clean + counts.noRoster > 0) {
      footerParts.push('Use the dropdown below to Quick Add unflagged names to a list.');
    } else {
      footerParts.push('No flags this image.');
    }
  } else {
    if (flaggedCount > 0) {
      footerParts.push('Tip: /la-roster <name> for the full roster of any flagged hit.');
    } else {
      footerParts.push('No flags. Re-run with a fresh image to re-check.');
    }
  }
  footerParts.push('Source: blacklist + whitelist + watchlist + trusted');

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  return { embed, counts };
}
