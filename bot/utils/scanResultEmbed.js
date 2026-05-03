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
 * @returns {{stopReason: 'completed'|'stopped'|'cap-hit', hasRemaining: boolean, remaining: number}}
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
  const scanned = result?.scannedCandidates ?? 0;
  const cancelled = result?.cancelled === true;

  const remaining = Math.max(0, totalEligible - scanned);
  const hasRemaining = remaining > 0;

  let stopReason;
  if (cancelled) stopReason = 'stopped';
  else if (hasRemaining) stopReason = 'cap-hit';
  else stopReason = 'completed';

  return { stopReason, hasRemaining, remaining };
}

const STATE_STYLE = {
  completed: { icon: ICONS.done,    color: COLORS.success, label: 'Scan complete' },
  'cap-hit': { icon: ICONS.search,  color: COLORS.warning, label: 'Scan paused at candidate limit' },
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

  const titleParts = [];
  if (kind === 'enrich') {
    titleParts.push('Enrich result');
  } else if (kind === 'roster-hidden') {
    titleParts.push('Hidden roster scan');
  } else {
    titleParts.push('Deep scan result');
  }
  titleParts.push('·');
  titleParts.push(target.name);

  const sections = [];

  // 1. State banner. Plain bolded line; the title icon already carries
  // most of the state signal so this is a one-line confirmation.
  sections.push(`**${style.label}**`);

  if (summaryLine) {
    sections.push(summaryLine);
  }

  // 2. Hidden roster notice. Only fires when the target's roster is
  // private, since stronghold detection has stronger limitations there
  // (no direct alt list to cross-check against).
  if (target.isHidden) {
    sections.push(
      `> ${ICONS.locked} Roster of **${target.name}** is hidden on bible.\n` +
      `> Alts below were matched by stronghold fingerprint (same SH name + roster level), ` +
      `not a direct roster scan. Mechanically reliable but only sees alts in the same guild.`
    );
  }

  // 3. Stats grid as a compact prose line. Discord's inline fields would
  // wrap unpredictably for 4-5 short numbers; a single line reads better.
  const statsParts = [
    `**Scanned** ${result.scannedCandidates ?? 0}`,
    `**Found** ${alts.length}`,
    `**Failed** ${result.failedCandidates ?? 0}`,
  ];
  if ((result.rateLimitRetries ?? 0) > 0) {
    statsParts.push(`**429 retries** ${result.rateLimitRetries}`);
  }
  if (state.remaining > 0) {
    statsParts.push(`**Remaining** ${state.remaining}`);
  }
  if (Number.isFinite(result.totalMembers)) {
    statsParts.push(`Guild ${result.totalMembers}`);
  }
  sections.push(statsParts.join(' · '));

  // 4. Stop-reason hint. The banner + stats already say "stopped X/Y";
  // this line tells the officer WHY and what they can do.
  if (state.stopReason === 'stopped') {
    sections.push(
      `Scan was stopped before reaching the end. ${state.remaining} eligible candidate(s) ` +
      `were not checked. Hit **Continue scan** to pick up where this run left off.`
    );
  } else if (state.stopReason === 'cap-hit') {
    sections.push(
      `Scan reached the candidate cap (${result.candidateLimit ?? 'configured limit'}). ` +
      `${state.remaining} eligible candidate(s) above that cap were not checked. ` +
      `Hit **Continue scan** to walk the rest with the same gentle throttle.`
    );
  }

  // 5. Alt list block. Header doubles as a count so a reader scrolling
  // through history can see at a glance how many came back.
  if (altList) {
    sections.push(`**Alts found (${alts.length}):**\n${altList}`);
  }

  // 6. Action hint. Reserved for caller-specific next-step copy
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
    .setTitle(`${finalIcon}  ${titleParts.join(' ')}`)
    .setDescription(description)
    .setColor(finalColor)
    .setTimestamp();

  if (target.profileUrl) {
    embed.setURL(target.profileUrl);
  }

  const footerParts = [];
  if (target.guildName) footerParts.push(`Guild ${target.guildName}`);
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
