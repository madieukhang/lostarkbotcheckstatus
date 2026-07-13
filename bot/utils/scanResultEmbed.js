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

import { COLORS, ICONS } from './ui.js';
import { createArtistEmbed } from './artistVoice.js';
import { truncateInlineText } from './discordText.js';
import { rosterUrl } from './rosterLink.js';
import { getClassEmoji } from '../models/Class.js';
import { t } from '../services/i18n/index.js';

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

  let stopReason;
  if (pausedForFailureStorm) stopReason = 'failure-storm';
  else if (abortedBySystem) stopReason = 'scan-aborted';
  else if (cancelled) stopReason = 'stopped';
  else if (hasRemaining) stopReason = 'cap-hit';
  else stopReason = 'completed';

  return { stopReason, hasRemaining, remaining };
}

const STATE_STYLE = {
  completed: { icon: ICONS.done, color: COLORS.success, localeKey: 'completed' },
  'cap-hit': { icon: ICONS.search, color: COLORS.warning, localeKey: 'capHit' },
  'failure-storm': { icon: ICONS.warn, color: COLORS.warning, localeKey: 'failureStorm' },
  'scan-aborted': { icon: ICONS.warn, color: COLORS.warning, localeKey: 'aborted' },
  stopped: { icon: '🛑', color: COLORS.warning, localeKey: 'stopped' },
};

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
  const lines = visible.map((alt, i) => {
    const link = rosterUrl(alt.name);
    const cls = alt.className || alt.classId || '?';
    // Class icon replaces the className text and sits BEFORE the
    // character name (per project styling decision). Falls back to
    // the className text when the bootstrap hasn't mapped this class
    // yet so the row still carries the class info.
    const classPrefix = getClassEmoji(cls) || cls;
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    const isNewMark = newAltsSet?.has(String(alt.name).toLowerCase()) ? ` \`${t('dialogue.scan.result.newTag', lang)}\`` : '';
    return `${i + 1}. ${classPrefix} **[${alt.name}](${link})** · \`${ilvl}\`${isNewMark}`;
  });
  const extra = alts.length > visible.length
    ? `\n*${t('dialogue.scan.result.more', lang, { count: alts.length - visible.length })}*`
    : '';
  return lines.join('\n') + extra;
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
  let kindLabel;
  if (kind === 'enrich') kindLabel = t('dialogue.scan.result.kinds.enrich', lang);
  else if (kind === 'roster-hidden') kindLabel = t('dialogue.scan.result.kinds.hidden', lang);
  else kindLabel = t('dialogue.scan.result.kinds.deep', lang);
  const stateLabel = t(`dialogue.scan.result.states.${style.localeKey}`, lang);

  const sections = [];

  // 1. Summary lead. Combines the caller-supplied summary with the state label
  // so the outcome and terminal state appear in one paragraph.
  if (summaryLine) {
    sections.push(`${summaryLine}\n*${stateLabel}.*`);
  } else {
    sections.push(`*${stateLabel}.*`);
  }

  // 2. Hidden roster notice. Single-line italic, less verbose than the
  // prior two-line blockquote. The detailed stronghold-fingerprint explanation
  // remains in the help docs and completion DM, so this card omits it.
  if (target.isHidden) {
    sections.push(
      `${ICONS.locked} *${t('dialogue.scan.result.hiddenNotice', lang)}*`
    );
  }

  // 3. Stop-reason hint. The title icon carries the outcome; this paragraph
  // carries the cause and next action in a shorter form than the prior copy.
  let stopHint = '';
  if (state.stopReason === 'stopped') {
    stopHint = t('dialogue.scan.result.stoppedHint', lang, { remaining: state.remaining });
  } else if (state.stopReason === 'scan-aborted') {
    stopHint = t('dialogue.scan.result.abortedHint', lang, {
      label: result.abortLabel || t('dialogue.scan.result.issue', lang),
      detail: result.abortDetail || '',
    });
  } else if (state.stopReason === 'failure-storm') {
    const attempted = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
    const failed = result.failedCandidates ?? 0;
    const rate = attempted > 0 ? Math.round((failed / attempted) * 100) : 0;
    const lastError = truncateInlineText(result.lastFailureReason, 140);
    stopHint = t('dialogue.scan.result.failureHint', lang, {
      failed,
      attempted,
      rate,
      lastError: lastError ? t('dialogue.scan.result.lastError', lang, { error: lastError }) : '',
    });
  } else if (state.stopReason === 'cap-hit') {
    stopHint = t('dialogue.scan.result.capHint', lang, {
      cap: result.candidateLimit ?? t('dialogue.scan.result.configured', lang),
      remaining: state.remaining,
    });
  }
  if (stopHint) sections.push(stopHint);

  // 4. Alt list block. The header also exposes the result count when scanning
  // message history.
  if (altList) {
    sections.push(`**🎯 ${t('dialogue.scan.result.altsFound', lang, { count: alts.length })}**\n${altList}`);
  }

  // 5. Action hint. Reserved for caller-specific next-step copy
  // (e.g. enrich: "Confirm to append all N to allCharacters").
  if (actionHint) {
    sections.push(actionHint);
  }

  // Discord description ceiling is 4096; the alt-list cap of 25 plus
  // notices typically lands around 1.5-2k chars. The `.slice(0, 4096)`
  // is a safety net for unusually long class names or names with
  // exotic encoding overhead.
  const description = sections.join('\n\n').slice(0, 4096);

  const embed = createArtistEmbed(lang)
    .setTitle(`${finalIcon}  ${kindLabel} · ${target.name}`)
    .setDescription(description)
    .setColor(finalColor)
    .setTimestamp();

  if (target.profileUrl) {
    embed.setURL(target.profileUrl);
  }

  // Stats grid as inline fields. Discord renders three inline fields per row,
  // separating metrics from the narrative description. The prior `·`-joined
  // prose line became difficult to scan with five or six active metrics.
  const checkedCandidates = result.checkedCandidates ?? result.scannedCandidates ?? 0;
  const attemptedCandidates = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
  const fields = [
    { name: `🔍 ${t('dialogue.scan.result.fields.checked', lang)}`, value: String(checkedCandidates), inline: true },
    { name: `🎯 ${t('dialogue.scan.result.fields.found', lang)}`, value: String(alts.length), inline: true },
    { name: `⚠️ ${t('dialogue.scan.result.fields.failed', lang)}`, value: String(result.failedCandidates ?? 0), inline: true },
  ];
  if (state.remaining > 0) {
    fields.push({ name: `📋 ${t('dialogue.scan.result.fields.remaining', lang)}`, value: String(state.remaining), inline: true });
  }
  if (attemptedCandidates > checkedCandidates) {
    fields.push({ name: `🔁 ${t('dialogue.scan.result.fields.attempts', lang)}`, value: String(attemptedCandidates), inline: true });
  }
  if ((result.rateLimitRetries ?? 0) > 0) {
    fields.push({ name: `⏱️ ${t('dialogue.scan.result.fields.retries', lang)}`, value: String(result.rateLimitRetries), inline: true });
  }
  if ((result.scraperApiRequests ?? 0) > 0) {
    fields.push({ name: `🌐 ${t('dialogue.scan.result.fields.scraper', lang)}`, value: String(result.scraperApiRequests), inline: true });
  }
  embed.addFields(...fields);

  const footerParts = [];
  if (target.guildName) footerParts.push(t('dialogue.scan.result.footer.guild', lang, { guild: target.guildName }));
  if (Number.isFinite(result.totalMembers)) footerParts.push(t('dialogue.scan.result.footer.members', lang, { count: result.totalMembers }));
  if (result.candidateLimit) footerParts.push(t('dialogue.scan.result.footer.cap', lang, { count: result.candidateLimit }));
  if (Number.isFinite(result.excludedCandidates) && result.excludedCandidates > 0) {
    footerParts.push(t('dialogue.scan.result.footer.excluded', lang, { count: result.excludedCandidates }));
  }
  if (footerParts.length > 0) {
    embed.setFooter({ text: footerParts.join(' · ') });
  }

  return { embed, state };
}

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
  const row = new ActionRowBuilder();

  if (kind === 'enrich') {
    if (hasRemaining) {
      // Partial result: Continue lets the officer keep scanning,
      // Save commits whatever was found so far, Discard drops the session.
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`list-enrich:continue:${sessionId}`)
          .setLabel(t('common.actions.continueScan', lang))
          .setEmoji(ICONS.refresh)
          .setStyle(ButtonStyle.Primary)
      );
      if (hasAlts) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`list-enrich:confirm:${sessionId}`)
            .setLabel(t('common.actions.savePartial', lang, { count: newAltsCount ?? 0 }))
            .setStyle(ButtonStyle.Success)
        );
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`list-enrich:cancel:${sessionId}`)
          .setLabel(t('common.actions.discard', lang))
          .setStyle(ButtonStyle.Secondary)
      );
      return row;
    }

    // Full scan path: only Save + Cancel make sense (no Continue).
    if (hasAlts) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`list-enrich:confirm:${sessionId}`)
          .setLabel(t('common.actions.confirmAdd', lang, { count: newAltsCount ?? 0 }))
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`list-enrich:cancel:${sessionId}`)
          .setLabel(t('common.actions.cancel', lang))
          .setStyle(ButtonStyle.Secondary)
      );
      return row;
    }

    return null;
  }

  if (kind === 'roster') {
    if (hasRemaining) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`roster-deep:continue:${sessionId}`)
          .setLabel(t('common.actions.continueScan', lang))
          .setEmoji(ICONS.refresh)
          .setStyle(ButtonStyle.Primary)
      );
      return row;
    }
    return null;
  }

  return null;
}
