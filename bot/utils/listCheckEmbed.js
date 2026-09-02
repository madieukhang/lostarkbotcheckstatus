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
import { t } from '../services/i18n/index.js';
import { groupListCheckResults } from '../services/list-check/displayGroups.js';
import { didListCheckNameChange } from '../services/list-check/matchResolution.js';
import { COLORS } from './ui.js';

function countListCheckStates(results) {
  const counts = {
    black: 0,
    watch: 0,
    white: 0,
    trusted: 0,
    notListed: 0,
  };
  for (const group of groupListCheckResults(results)) {
    counts[group.status] += 1;
  }
  return counts;
}

const LIST_CHECK_OUTCOME_RULES = [
  { matches: ({ black }) => black > 0, color: COLORS.danger, titleIcon: '⛔' },
  { matches: ({ watch }) => watch > 0, color: COLORS.warning, titleIcon: '⚠️' },
  {
    matches: ({ white, trusted }) => white > 0 || trusted > 0,
    color: COLORS.success,
    titleIcon: '✅',
  },
  { matches: () => true, color: COLORS.info, titleIcon: '🔍' },
];

function resolveListCheckOutcome(counts) {
  const { color, titleIcon } = LIST_CHECK_OUTCOME_RULES.find(({ matches }) => matches(counts));
  return { color, titleIcon };
}

function buildBreakdownTitle(counts, titleIcon, limitedNamesCount, lang) {
  const parts = [
    counts.black ? `⛔ ${counts.black}` : '',
    counts.watch ? `⚠️ ${counts.watch}` : '',
    counts.white ? `✅ ${counts.white}` : '',
    counts.trusted ? `🛡️ ${counts.trusted}` : '',
    counts.notListed
      ? `❓ ${counts.notListed} ${t('dialogue.check.embed.notListed', lang)}`
      : '',
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');

  const countKey = limitedNamesCount === 1 ? 'nameOne' : 'nameMany';
  return `${titleIcon} ${limitedNamesCount} ${t(`dialogue.check.${countKey}`, lang)}`;
}

function buildCheckChrome({ results, counts, limitedNamesCount, mode, lang, titleIcon }) {
  const modeKey = mode === 'auto' ? 'autoKicker' : 'slashKicker';
  const titlePrefix = t(`dialogue.check.embed.${modeKey}`, lang);
  const kicker = `// ${titlePrefix} · ${limitedNamesCount} ${t('dialogue.check.embed.names', lang)}`;
  const isImageCheck = results.some((result) => result.inputSource === 'ocr');
  let authorName = kicker;
  if (isImageCheck) {
    authorName = `📸 ${t('dialogue.check.embed.imageAuthor', lang)}`;
  } else if (mode === 'auto') {
    authorName = `🔎 ${t('dialogue.check.embed.textAuthor', lang)}`;
  }

  return {
    authorName,
    title: buildBreakdownTitle(counts, titleIcon, limitedNamesCount, lang),
    usesCompactChrome: mode === 'auto' || isImageCheck,
  };
}

function buildResultNotes({ ignoredCount, unverifiedCount, maxNames, lang }) {
  const countKey = ignoredCount === 1 ? 'nameOne' : 'nameMany';
  const notes = [
    ignoredCount > 0
      ? t('dialogue.check.embed.ignored', lang, {
          count: ignoredCount,
          word: t(`dialogue.check.${countKey}`, lang),
          limit: maxNames ?? t('dialogue.check.embed.configured', lang),
        })
      : '',
    unverifiedCount > 0
      ? t('dialogue.check.embed.unverified', lang, { count: unverifiedCount })
      : '',
  ].filter(Boolean);
  return notes.length > 0
    ? `\n\n${notes.map((note) => `*${note}*`).join('\n')}`
    : '';
}

function buildCorrectionFooterPart(correctedResults, lang) {
  if (correctedResults.length === 0) return '';
  const correctionKey = correctedResults.some((result) => result.inputSource === 'ocr')
    ? 'correctedOcr'
    : 'correctedText';
  return t(`dialogue.check.embed.${correctionKey}`, lang, {
    count: correctedResults.length,
  });
}

function resolveCheckHintKey({ counts, flaggedCount, mode }) {
  if (mode !== 'auto') return flaggedCount > 0 ? 'rosterTip' : 'rerunTip';
  if (flaggedCount > 0) return 'quickFlagged';
  return counts.notListed > 0 ? 'quickClean' : '';
}

function buildCheckFooter({ counts, flaggedCount, correctedResults, mode, lang }) {
  const statusKey = flaggedCount > 0 ? 'flagged' : 'clear';
  const correction = buildCorrectionFooterPart(correctedResults, lang);
  const hintKey = resolveCheckHintKey({ counts, flaggedCount, mode });
  return [
    `// ${t(`dialogue.check.embed.${statusKey}`, lang, { count: flaggedCount })}`,
    correction,
    hintKey ? t(`dialogue.check.embed.${hintKey}`, lang) : '',
    t('dialogue.check.embed.source', lang),
  ].filter(Boolean);
}

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
 * @param {number} [options.unverifiedCount=0] - OCR/text candidates rejected
 *   because neither Bible/snapshot nor a Mongo list record confirmed them
 * @param {number} [options.maxNames] - The cap value, used in the "ignored" note
 * @param {'slash'|'auto'} [options.mode='slash'] - Drives small copy differences (title verb, footer)
 * @returns {ListCheckRender}
 */
export function buildListCheckEmbed({
  results,
  formattedLines,
  limitedNamesCount,
  ignoredCount = 0,
  unverifiedCount = 0,
  maxNames,
  mode = 'slash',
  lang = 'en',
}) {
  // Per-category counts. Mirrors the priority logic in formatCheckResults
  // so the badge counts and the line-list categorisation never drift.
  const counts = countListCheckStates(results);
  const flaggedCount = counts.black + counts.watch;
  const correctedResults = results.filter(didListCheckNameChange);
  const { color, titleIcon } = resolveListCheckOutcome(counts);

  // HUD-merged header. The mode + total name count live on the author kicker
  // line; the title IS the breakdown, ordered by severity (black -> watch ->
  // white -> trusted -> notListed). Plain text (embed titles ignore markdown)
  // so the title's leading emoji is naturally the strongest outcome present -
  // no separate "Outcome:" line and no redundant count line needed.
  const { authorName, title, usesCompactChrome } = buildCheckChrome({
    results,
    counts,
    limitedNamesCount,
    mode,
    lang,
    titleIcon,
  });
  const resultNotes = buildResultNotes({
    ignoredCount,
    unverifiedCount,
    maxNames,
    lang,
  });

  // Description leads straight with the per-name list now (the breakdown moved
  // up into the title). Ceiling is 4096; the slice is a safety net for long
  // reasons / many similar-name suggestions.
  const description = (`${formattedLines.join('\n')}${resultNotes}`).slice(0, 4096);

  // Stats grid (Checked / Flagged / Cleared) was a 3-up inline field
  // panel pre-v0.5.73. The Outcome breakdown line at the top of the
  // description carries the same per-status info (with finer
  // granularity), so the panel duplicated information and increased visual
  // density. Reintroduce it only when separate aggregate counts are required.
  // Aggregate cleared count is therefore intentionally not computed here.

  // Footer hint differs between modes:
  //   slash:  Tip toward /la-roster on a flagged hit OR retry hint when unflagged.
  //   auto:   Note that the dropdown below provides Quick Add for unflagged
  //           names (the auto-check pipeline supplies the select menu).
  // Footer is a HUD status line: a // FLAGGED n (or // CLEAR) tag, the
  // mode-specific tip, then the source citation.
  const footerParts = buildCheckFooter({
    counts,
    flaggedCount,
    correctedResults,
    mode,
    lang,
  });

  const embed = createArtistEmbed(lang)
    .setAuthor({ name: authorName })
    .setDescription(description)
    .setColor(color);

  // Auto-check cards use one compact source-aware author line. Per-roster rows
  // already carry status and counts, so repeating a title, source footer, and
  // timestamp only adds visual noise. Image-driven slash checks stay compact
  // for the same reason; typed slash checks retain their command context.
  if (!usesCompactChrome) {
    embed
      .setTitle(title)
      .setFooter({ text: footerParts.join(' · ') })
      .setTimestamp();
  }

  return { embed, counts };
}
