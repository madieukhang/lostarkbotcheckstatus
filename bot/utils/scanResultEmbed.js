/**
 * scanResultEmbed.js
 *
 * Unified post-scan embed + button matrix for the long-running stronghold
 * deep scans (/la-list enrich, /la-roster deep:true). Replaces the four
 * branch-specific embed builds that grew up alongside the scan flow
 * (completed-with-alts, completed-no-alts, stopped-with-alts,
 * stopped-no-alts) so all paths render with consistent layout, icon
 * vocabulary, and resume affordances.
 *
 * Layout (top to bottom):
 *   1. Status banner   - completed | stopped | cap-hit, color follows state
 *   2. Hidden notice   - rendered only when target's roster is hidden;
 *                        explains stronghold detection mechanics + limits
 *   3. Stronghold note - always present; same-account match logic
 *   4. Stats grid      - scanned / found / failed / remaining counts
 *   5. Alt list        - bullet rows with bible roster links, capped 25
 *   6. Profile link    - title click jumps to lostark.bible character page
 *
 * Buttons are returned separately so the caller can pick the right
 * action set for the command kind (enrich has Save/Continue/Discard;
 * roster deep has Continue only since it does not persist).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { COLORS, ICONS, padInlineRow } from './ui.js';
import { createArtistEmbed } from './artistVoice.js';
import { truncateInlineText } from './discordText.js';
import { formatAltLine } from '../handlers/list/trackedAltsRender.js';
import { t } from '../services/i18n/index.js';

const STOP_REASON_RULES = [
  ['failure-storm', ({ pausedForFailureStorm }) => pausedForFailureStorm],
  ['scan-aborted', ({ abortedBySystem }) => abortedBySystem],
  ['stopped', ({ cancelled }) => cancelled],
  ['cap-hit', ({ hasRemaining }) => hasRemaining],
];

/**
 * Compute the post-scan state from the result envelope. Stop reasons are
 * mutually exclusive (a scan either ran to completion, was stopped by
 * the user, or hit the candidate cap), so derive once and reuse for both
 * embed copy and button selection.
 *
 * @param {object} result - Result envelope from detectAltsViaStronghold.
 * @returns {{stopReason: 'completed'|'stopped'|'scan-aborted'|'failure-storm'|'cap-hit', hasRemaining: boolean, remaining: number}}
 */
export function deriveScanState(result) {
  // Prefer totalEligibleInGuild for the remaining-count math because it is
  // invariant across Continue passes (= every guild member ilvl >= 1700
  // minus the target). eligibleCandidates is per-pass-after-exclude and
  // would under-count once Continue chains together. Fall back gracefully
  // for older callers that supply only the per-pass counts.
  const totalEligible = Number.isFinite(result?.totalEligibleInGuild)
    ? result.totalEligibleInGuild
    : (Number.isFinite(result?.eligibleCandidates)
      ? result.eligibleCandidates
      : (result?.totalCandidates ?? 0));
  const scanned = result?.checkedCandidates ?? result?.scannedCandidates ?? 0;
  const cancelled = result?.cancelled === true;
  const pausedForFailureStorm = result?.pausedForFailureStorm === true;
  const abortedBySystem = Boolean(result?.abortReason && result.abortReason !== 'user-stopped');

  const remaining = Math.max(0, totalEligible - scanned);
  const hasRemaining = remaining > 0;

  const flags = { pausedForFailureStorm, abortedBySystem, cancelled, hasRemaining };
  const stopReason = STOP_REASON_RULES.find(([, matches]) => matches(flags))?.[0] ?? 'completed';

  return { stopReason, hasRemaining, remaining };
}

const STATE_STYLE = {
  completed: { icon: ICONS.done, color: COLORS.success, localeKey: 'completed' },
  'cap-hit': { icon: ICONS.search, color: COLORS.warning, localeKey: 'capHit' },
  'failure-storm': { icon: ICONS.warn, color: COLORS.warning, localeKey: 'failureStorm' },
  'scan-aborted': { icon: ICONS.warn, color: COLORS.warning, localeKey: 'aborted' },
  stopped: { icon: '🛑', color: COLORS.warning, localeKey: 'stopped' },
};

const KIND_LOCALE_KEYS = {
  enrich: 'enrich',
  'roster-hidden': 'hidden',
};

const STOP_HINT_BUILDERS = {
  stopped: ({ state, lang }) => (
    t('dialogue.scan.result.stoppedHint', lang, { remaining: state.remaining })
  ),
  'scan-aborted': ({ result, lang }) => t('dialogue.scan.result.abortedHint', lang, {
    label: result.abortLabel || t('dialogue.scan.result.issue', lang),
    detail: result.abortDetail || '',
  }),
  'failure-storm': ({ result, lang }) => {
    const attempted = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
    const failed = result.failedCandidates ?? 0;
    const rate = attempted > 0 ? Math.round((failed / attempted) * 100) : 0;
    const lastError = truncateInlineText(result.lastFailureReason, 140);
    return t('dialogue.scan.result.failureHint', lang, {
      failed,
      attempted,
      rate,
      lastError: lastError
        ? t('dialogue.scan.result.lastError', lang, { error: lastError })
        : '',
    });
  },
  'cap-hit': ({ state, result, lang }) => t('dialogue.scan.result.capHint', lang, {
    cap: result.candidateLimit ?? t('dialogue.scan.result.configured', lang),
    remaining: state.remaining,
  }),
};

function buildStopHint(state, result, lang) {
  return STOP_HINT_BUILDERS[state.stopReason]?.({ state, result, lang }) ?? '';
}

/**
 * Build the alt-list bullet block. Names link out to lostark.bible roster
 * page so the officer can click straight through to verify a match.
 * Capped to 25 visible rows with an overflow tail so the embed
 * description stays well under Discord's 4096-char ceiling even with
 * the surrounding stats + notice blocks.
 */
function buildAltList(alts, { newAltsSet, lang = 'en' } = {}) {
  if (!Array.isArray(alts) || alts.length === 0) return '';
  const visible = alts.slice(0, 25);
  // Rows go through the shared formatter so this list keeps pace with
  // every other character list in the bot · the local copy it replaces
  // had already fallen behind on the CP badge. The "new" tag is appended
  // here because it belongs to this card alone.
  const lines = visible.map((alt, i) => {
    const isNewMark = newAltsSet?.has(String(alt.name).toLowerCase()) ? ` \`${t('dialogue.scan.result.newTag', lang)}\`` : '';
    const record = { ...alt, className: alt.className || alt.classId || '' };
    return `${formatAltLine(alt.name, i, record)}${isNewMark}`;
  });
  const extra = alts.length > visible.length
    ? `\n*${t('dialogue.scan.result.more', lang, { count: alts.length - visible.length })}*`
    : '';
  return lines.join('\n') + extra;
}

function buildResultSections({ target, result, state, style, alts, altList, summaryLine, actionHint, lang }) {
  const stateLabel = t(`dialogue.scan.result.states.${style.localeKey}`, lang);
  const stopHint = buildStopHint(state, result, lang);
  return [
    summaryLine ? `${summaryLine}\n*${stateLabel}.*` : `*${stateLabel}.*`,
    target.isHidden
      ? `${ICONS.locked} *${t('dialogue.scan.result.hiddenNotice', lang)}*`
      : '',
    stopHint,
    altList
      ? `**🎯 ${t('dialogue.scan.result.altsFound', lang, { count: alts.length })}**\n${altList}`
      : '',
    actionHint,
  ].filter(Boolean);
}

function buildResultFields(result, state, altCount, lang) {
  const checked = result.checkedCandidates ?? result.scannedCandidates ?? 0;
  const attempted = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
  const fields = [
    { name: `🔍 ${t('dialogue.scan.result.fields.checked', lang)}`, value: String(checked), inline: true },
    { name: `🎯 ${t('dialogue.scan.result.fields.found', lang)}`, value: String(altCount), inline: true },
    { name: `⚠️ ${t('dialogue.scan.result.fields.failed', lang)}`, value: String(result.failedCandidates ?? 0), inline: true },
  ];
  const optional = [
    [state.remaining > 0, '📋', 'remaining', state.remaining],
    [attempted > checked, '🔁', 'attempts', attempted],
    [(result.rateLimitRetries ?? 0) > 0, '⏱️', 'retries', result.rateLimitRetries],
    [(result.scraperApiRequests ?? 0) > 0, '🌐', 'scraper', result.scraperApiRequests],
  ];
  fields.push(...optional
    .filter(([include]) => include)
    .map(([, icon, key, value]) => ({
      name: `${icon} ${t(`dialogue.scan.result.fields.${key}`, lang)}`,
      value: String(value),
      inline: true,
    })));
  // Three fixed counters plus up to four optional ones, so the total
  // lands anywhere from three to seven · pad so the stats grid keeps its
  // columns instead of ending on a stretched leftover.
  return padInlineRow(fields);
}

function buildResultFooter(target, result, lang) {
  return [
    target.guildName
      ? t('dialogue.scan.result.footer.guild', lang, { guild: target.guildName })
      : '',
    Number.isFinite(result.totalMembers)
      ? t('dialogue.scan.result.footer.members', lang, { count: result.totalMembers })
      : '',
    result.candidateLimit
      ? t('dialogue.scan.result.footer.cap', lang, { count: result.candidateLimit })
      : '',
    Number.isFinite(result.excludedCandidates) && result.excludedCandidates > 0
      ? t('dialogue.scan.result.footer.excluded', lang, { count: result.excludedCandidates })
      : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Build the unified scan-result embed.
 *
 * @param {object} options
 * @param {object} options.target - { name, isHidden, guildName, strongholdName?, rosterLevel?, profileUrl? }
 * @param {object} options.result - detectAltsViaStronghold result envelope
 * @param {Array<object>} [options.alts] - Override which alts to display (e.g. only the new-on-entry subset)
 * @param {Set<string>} [options.newAltsSet] - Lowercased names tagged as "new" in the alt list
 * @param {string} options.kind - 'enrich' | 'roster-hidden' | 'roster-visible'
 * @param {object} [options.contextStyle] - { icon, color, label } - list-type styling for enrich
 * @param {number} [options.startedAt] - epoch ms; renders elapsed time line when present
 * @param {string} [options.summaryLine] - Optional localized one-line summary
 * @param {string} [options.actionHint] - Optional trailing line guiding next action
 * @returns {{embed: EmbedBuilder, state: {stopReason: string, hasRemaining: boolean, remaining: number}}}
 */
export function buildScanResultEmbed({
  target,
  result,
  alts: altsOverride,
  newAltsSet,
  kind,
  contextStyle,
  summaryLine,
  actionHint,
  lang = 'en',
}) {
  const state = deriveScanState(result);
  const style = STATE_STYLE[state.stopReason];

  const alts = Array.isArray(altsOverride) ? altsOverride : (result?.alts ?? []);
  const altList = buildAltList(alts, { newAltsSet, lang });

  // Color precedence: the list-type tint (blacklist red, watch yellow) wins
  // for enrich because a watcher reading their list cares more about the
  // entry's category than the scan's success/warning state. Roster deep
  // has no list context, so the state color drives the embed.
  const finalColor = contextStyle?.color ?? style.color;
  const finalIcon = contextStyle?.icon ?? style.icon;

  // Title carries kind + state in a single line. The state icon makes a
  // separate bold banner in the description redundant.
  const kindLocaleKey = KIND_LOCALE_KEYS[kind] ?? 'deep';
  const kindLabel = t(`dialogue.scan.result.kinds.${kindLocaleKey}`, lang);
  const sections = buildResultSections({
    target,
    result,
    state,
    style,
    alts,
    altList,
    summaryLine,
    actionHint,
    lang,
  });
  const description = sections.join('\n\n').slice(0, 4096);

  const embed = createArtistEmbed(lang)
    .setTitle(`${finalIcon}  ${kindLabel} · ${target.name}`)
    .setDescription(description)
    .setColor(finalColor)
    .setTimestamp();

  if (target.profileUrl) embed.setURL(target.profileUrl);
  embed.addFields(...buildResultFields(result, state, alts.length, lang));
  const footer = buildResultFooter(target, result, lang);
  if (footer) embed.setFooter({ text: footer });

  return { embed, state };
}

function createScanButton({ customId, labelKey, labelParams, emoji, style }, lang) {
  const button = new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(t(labelKey, lang, labelParams))
    .setStyle(style);
  return emoji ? button.setEmoji(emoji) : button;
}

function buildEnrichButtons({ sessionId, hasAlts, hasRemaining, newAltsCount, lang }) {
  if (hasRemaining) {
    return [
      createScanButton({
        customId: `list-enrich:continue:${sessionId}`,
        labelKey: 'common.actions.continueScan',
        emoji: ICONS.refresh,
        style: ButtonStyle.Primary,
      }, lang),
      hasAlts ? createScanButton({
        customId: `list-enrich:confirm:${sessionId}`,
        labelKey: 'common.actions.savePartial',
        labelParams: { count: newAltsCount ?? 0 },
        style: ButtonStyle.Success,
      }, lang) : null,
      createScanButton({
        customId: `list-enrich:cancel:${sessionId}`,
        labelKey: 'common.actions.discard',
        style: ButtonStyle.Secondary,
      }, lang),
    ].filter(Boolean);
  }

  return hasAlts
    ? [
      createScanButton({
        customId: `list-enrich:confirm:${sessionId}`,
        labelKey: 'common.actions.confirmAdd',
        labelParams: { count: newAltsCount ?? 0 },
        style: ButtonStyle.Success,
      }, lang),
      createScanButton({
        customId: `list-enrich:cancel:${sessionId}`,
        labelKey: 'common.actions.cancel',
        style: ButtonStyle.Secondary,
      }, lang),
    ]
    : [];
}

function buildRosterButtons({ sessionId, hasRemaining, lang }) {
  return hasRemaining
    ? [createScanButton({
      customId: `roster-deep:continue:${sessionId}`,
      labelKey: 'common.actions.continueScan',
      emoji: ICONS.refresh,
      style: ButtonStyle.Primary,
    }, lang)]
    : [];
}

const BUTTON_BUILDERS = {
  enrich: buildEnrichButtons,
  roster: buildRosterButtons,
};

/**
 * Build the action button row for the scan-result card. Button shape
 * depends on the calling command (enrich persists alts, roster deep does
 * not) and the post-scan state (full vs partial).
 *
 * customId conventions:
 *   - list-enrich:confirm:<sid>   - save all discovered alts to entry
 *   - list-enrich:continue:<sid>  - resume scan with excludeNames
 *   - list-enrich:cancel:<sid>    - discard preview, no DB write
 *   - roster-deep:continue:<sid>  - resume read-only deep scan
 *
 * @param {object} options
 * @param {string} options.kind - 'enrich' | 'roster'
 * @param {string} options.sessionId
 * @param {boolean} options.hasAlts - alts.length > 0 (or newAlts for enrich)
 * @param {boolean} options.hasRemaining - state.hasRemaining
 * @param {number} [options.newAltsCount] - For enrich button label "Save N"
 * @returns {ActionRowBuilder|null} - null when no buttons apply
 */
export function buildScanResultButtons({
  kind,
  sessionId,
  hasAlts,
  hasRemaining,
  newAltsCount,
  lang = 'en',
}) {
  const buttons = BUTTON_BUILDERS[kind]?.({
    sessionId,
    hasAlts,
    hasRemaining,
    newAltsCount,
    lang,
  }) ?? [];

  return buttons.length > 0
    ? new ActionRowBuilder().addComponents(...buttons)
    : null;
}
