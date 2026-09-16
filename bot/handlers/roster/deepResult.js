import { t } from '../../services/i18n/index.js';
import { createRosterContinuationSession } from '../../utils/rosterDeepSession.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildScanResultEmbed, buildScanResultButtons } from '../../utils/scanResultEmbed.js';

/**
 * Render a roster deep-scan result and register its Continue session if allowed.
 * Callers retain their guild-context gate; the primary card snapshot and scan
 * totals must come from the same pass so Continue can resume without scraping.
 * @param {object} args
 * @param {string} args.callerId - original requester's Discord id, bound into
 *   the Continue session.
 * @param {string} args.name - queried character name.
 * @param {boolean} args.isHidden - hidden-roster variant of the result card.
 * @param {object|null} args.meta - scan target metadata (guildName, ...).
 * @param {Array|null} args.guildMembers - guild member snapshot captured in
 *   the same scan pass; the Continue resume needs it.
 * @param {object|null} args.altResult - deep-scan outcome (alts, remaining state).
 * @param {number} args.cap - candidate cap used by this scan pass.
 * @param {import('discord.js').EmbedBuilder} args.primaryEmbed - base card the
 *   caller already built; snapshotted to JSON for the session.
 * @param {boolean} [args.canContinue=true] - render without registering a
 *   Continue session when false (e.g. the caller lacks guild context).
 * @param {string} args.lang - locale for UI strings.
 * @returns {{embed: import('discord.js').EmbedBuilder|null, components: Array}}
 */
export function buildRosterDeepScanResult({
  callerId,
  name,
  isHidden,
  meta,
  guildMembers,
  altResult,
  cap,
  primaryEmbed,
  canContinue = true,
  lang,
}) {
  if (!altResult) return { embed: null, components: [] };

  const { embed, state } = buildScanResultEmbed({
    target: { name, isHidden, guildName: meta?.guildName, profileUrl: rosterUrl(name) },
    result: altResult,
    kind: isHidden ? 'roster-hidden' : 'roster-visible',
    summaryLine: isHidden || meta?.guildName
      ? t('dialogue.enrich.summary', lang, { guild: meta?.guildName, name, resumed: '' })
      : t('dialogue.enrich.noGuild.description', lang, { name }),
    lang,
  });
  if (!state.hasRemaining || !canContinue) return { embed, components: [] };

  const session = createRosterContinuationSession({
    callerId,
    targetName: name,
    isHidden,
    meta,
    guildMembers,
    altResult,
    cap,
    primaryEmbedJSON: primaryEmbed.toJSON(),
  });
  const buttonRow = buildScanResultButtons({
    kind: 'roster',
    sessionId: session.sessionId,
    hasAlts: (altResult.alts || []).length > 0,
    hasRemaining: true,
    lang,
  });
  return { embed, components: buttonRow ? [buttonRow] : [] };
}
