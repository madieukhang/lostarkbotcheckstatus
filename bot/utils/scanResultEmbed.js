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
  EmbedBuilder,
} from 'discord.js';

import { COLORS, ICONS } from './ui.js';

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
  completed: { icon: ICONS.done,    color: COLORS.success, label: 'Scan complete' },
  'cap-hit': { icon: ICONS.search,  color: COLORS.warning, label: 'Scan paused at candidate limit' },
  'failure-storm': { icon: ICONS.warn, color: COLORS.warning, label: 'Scan paused: bible is rejecting profiles' },
  'scan-aborted': { icon: ICONS.warn, color: COLORS.warning, label: 'Scan stopped: issue detected' },
  stopped:   { icon: '🛑',          color: COLORS.warning, label: 'Scan stopped early' },
};

/**
 * Build the alt-list bullet block. Names link out to lostark.bible roster
 * page so the officer can click straight through to verify a match.
 * Capped to 25 visible rows with an overflow tail so the embed
 * description stays well under Discord's 4096-char ceiling even with
 * the surrounding stats + notice blocks.
 */
function buildAltList(alts, { newAltsSet } = {}) {
  if (!Array.isArray(alts) || alts.length === 0) return '';
  const visible = alts.slice(0, 25);
  const lines = visible.map((alt, i) => {
    const link = `https://lostark.bible/character/NA/${encodeURIComponent(alt.name)}/roster`;
    const cls = alt.className || alt.classId || '?';
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    const isNewMark = newAltsSet?.has(String(alt.name).toLowerCase()) ? ' `new`' : '';
    return `${i + 1}. **[${alt.name}](${link})** · ${cls} · \`${ilvl}\`${isNewMark}`;
  });
  const extra = alts.length > visible.length
    ? `\n*... and ${alts.length - visible.length} more*`
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
 * @param {object} [options.contextStyle] - { icon, color, label } - list-type flavour for enrich
 * @param {number} [options.startedAt] - epoch ms; renders elapsed time line when present
 * @param {string} [options.summaryLine] - Optional one-line lead (e.g. "I scanned X members in guild Y")
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
}) {
  const state = deriveScanState(result);
  const style = STATE_STYLE[state.stopReason];

  const alts = Array.isArray(altsOverride) ? altsOverride : (result?.alts ?? []);
  const altList = buildAltList(alts, { newAltsSet });

  // Color precedence: the list-type tint (blacklist red, watch yellow) wins
  // for enrich because a watcher reading their list cares more about the
  // entry's category than the scan's success/warning state. Roster deep
  // has no list context, so the state color drives the embed.
  const finalColor = contextStyle?.color ?? style.color;
  const finalIcon = contextStyle?.icon ?? style.icon;

  // Title carries kind + state in a single line. The state icon prefix
  // is enough state signal that we no longer need a separate bolded
  // banner line in the description — saves one paragraph break.
  let kindLabel;
  if (kind === 'enrich') kindLabel = 'Enrich result';
  else if (kind === 'roster-hidden') kindLabel = 'Hidden roster scan';
  else kindLabel = 'Deep scan result';

  const sections = [];

  // 1. Summary lead. Combines summaryLine (caller-supplied "I scanned X
  // for Y") with state label so the reader knows in one paragraph what
  // happened and how it ended.
  if (summaryLine) {
    sections.push(`${summaryLine}\n*${style.label}.*`);
  } else {
    sections.push(`*${style.label}.*`);
  }

  // 2. Hidden roster notice. Single-line italic, less verbose than the
  // prior 2-line blockquote. The "explains how stronghold fingerprint
  // works" copy still appears once in the help docs and in DM, so
  // this card doesn't need to repeat the whole spiel.
  if (target.isHidden) {
    sections.push(
      `${ICONS.locked} *Target's roster is hidden; alts below come from stronghold fingerprint match (same SH + RL).*`
    );
  }

  // 3. Stop-reason hint. The state's title icon already says WHAT
  // happened; this paragraph explains WHY and what to do next. We
  // tighten the copy here vs the older multi-sentence version.
  let stopHint = '';
  if (state.stopReason === 'stopped') {
    stopHint = `Stopped before the end. **${state.remaining}** eligible candidate(s) unchecked · hit **Continue scan** to resume.`;
  } else if (state.stopReason === 'scan-aborted') {
    stopHint = `Stopped: **${result.abortLabel || 'Issue detected'}**.` +
      (result.abortDetail ? ` ${result.abortDetail}` : '') +
      ` Hit **Continue scan** later if the issue clears.`;
  } else if (state.stopReason === 'failure-storm') {
    const attempted = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
    const failed = result.failedCandidates ?? 0;
    const rate = attempted > 0 ? Math.round((failed / attempted) * 100) : 0;
    stopHint = `Bible rejected ${failed}/${attempted} profiles (${rate}%); I paused so we don't burn the rest. Failed candidates were not marked checked, so **Continue scan** will retry them.`;
  } else if (state.stopReason === 'cap-hit') {
    stopHint = `Hit the candidate cap (${result.candidateLimit ?? 'configured limit'}). **${state.remaining}** eligible candidate(s) above the cap unchecked · hit **Continue scan** to walk the rest.`;
  }
  if (stopHint) sections.push(stopHint);

  // 4. Alt list block. Header doubles as a count so a reader scrolling
  // through history can see at a glance how many came back.
  if (altList) {
    sections.push(`**🎯 Alts found (${alts.length}):**\n${altList}`);
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

  const embed = new EmbedBuilder()
    .setTitle(`${finalIcon}  ${kindLabel} · ${target.name}`)
    .setDescription(description)
    .setColor(finalColor)
    .setTimestamp();

  if (target.profileUrl) {
    embed.setURL(target.profileUrl);
  }

  // Stats grid as inline fields. Discord renders 3 inline fields side-
  // by-side which gives the card a clear "stats panel" affordance,
  // visually separated from the narrative description above. Older
  // version inlined these as a `·`-joined prose line which read
  // cluttered when 5-6 metrics were active simultaneously.
  const checkedCandidates = result.checkedCandidates ?? result.scannedCandidates ?? 0;
  const attemptedCandidates = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
  const fields = [
    { name: '🔍 Checked', value: String(checkedCandidates), inline: true },
    { name: '🎯 Found', value: String(alts.length), inline: true },
    { name: '⚠️ Failed', value: String(result.failedCandidates ?? 0), inline: true },
  ];
  if (state.remaining > 0) {
    fields.push({ name: '📋 Remaining', value: String(state.remaining), inline: true });
  }
  if (attemptedCandidates > checkedCandidates) {
    fields.push({ name: '🔁 Attempts', value: String(attemptedCandidates), inline: true });
  }
  if ((result.rateLimitRetries ?? 0) > 0) {
    fields.push({ name: '⏱️ 429 retries', value: String(result.rateLimitRetries), inline: true });
  }
  if ((result.scraperApiRequests ?? 0) > 0) {
    fields.push({ name: '🌐 ScraperAPI', value: String(result.scraperApiRequests), inline: true });
  }
  embed.addFields(...fields);

  const footerParts = [];
  if (target.guildName) footerParts.push(`Guild ${target.guildName}`);
  if (Number.isFinite(result.totalMembers)) footerParts.push(`${result.totalMembers} members`);
  if (result.candidateLimit) footerParts.push(`Cap ${result.candidateLimit}`);
  if (Number.isFinite(result.excludedCandidates) && result.excludedCandidates > 0) {
    footerParts.push(`Excluded ${result.excludedCandidates} from prior pass`);
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
}) {
  const row = new ActionRowBuilder();

  if (kind === 'enrich') {
    if (hasRemaining) {
      // Partial result: Continue lets the officer keep scanning,
      // Save commits whatever was found so far, Discard drops the session.
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`list-enrich:continue:${sessionId}`)
          .setLabel(`Continue scan`)
          .setEmoji(ICONS.refresh)
          .setStyle(ButtonStyle.Primary)
      );
      if (hasAlts) {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`list-enrich:confirm:${sessionId}`)
            .setLabel(`Save partial · ${newAltsCount ?? 0}`)
            .setStyle(ButtonStyle.Success)
        );
      }
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`list-enrich:cancel:${sessionId}`)
          .setLabel('Discard')
          .setStyle(ButtonStyle.Secondary)
      );
      return row;
    }

    // Full scan path: only Save + Cancel make sense (no Continue).
    if (hasAlts) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`list-enrich:confirm:${sessionId}`)
          .setLabel(`Confirm Add ${newAltsCount ?? 0}`)
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`list-enrich:cancel:${sessionId}`)
          .setLabel('Cancel')
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
          .setLabel('Continue scan')
          .setEmoji(ICONS.refresh)
          .setStyle(ButtonStyle.Primary)
      );
      return row;
    }
    return null;
  }

  return null;
}
