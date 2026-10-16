import { AlertSeverity, buildAlertEmbed } from '../../utils/alertEmbed.js';
import { t } from '../../services/i18n/index.js';
import { createRosterContinuationSession } from '../../utils/rosterDeepSession.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildScanResultEmbed, buildScanResultButtons } from '../../utils/scanResultEmbed.js';

// The first rule that applies names the cause; each key carries a title,
// description and footer for the notice. The no-guild footer points at
// `/la-list edit additional_names`, which has no entry to act on from a
// roster card, so that rule leaves its footer out.
const DEEP_NOT_RUN_NOTICE_RULES = [
  { applies: ({ meta }) => Boolean(meta) && !meta.guildName, key: 'dialogue.enrich.noGuild', omitFooter: true },
  { applies: ({ guildMembersUnavailable }) => guildMembersUnavailable, key: 'dialogue.enrich.guildUnavailable' },
  { applies: ({ meta }) => !meta, key: 'dialogue.enrich.metaMissing' },
  { applies: () => true, key: 'dialogue.roster.deepNotRunNotice' },
];

/**
 * Build the notice for a deep scan that was asked for and produced no result,
 * so the reply never reads as a scan that ran clean.
 * @param {object} args
 * @param {string} args.name - queried character name.
 * @param {object|null} args.meta - target metadata the caller fetched, or null
 *   when that fetch found none.
 * @param {boolean} [args.guildMembersUnavailable=false] - the guild member
 *   fetch failed.
 * @param {string} args.lang - locale for UI strings.
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildDeepScanNotRunNotice({ name, meta, guildMembersUnavailable = false, lang }) {
  const { key, omitFooter } = DEEP_NOT_RUN_NOTICE_RULES.find(({ applies }) => applies({ meta, guildMembersUnavailable }));
  const { footer, ...copy } = t(key, lang, { name });
  return buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    ...copy,
    footer: omitFooter ? undefined : footer,
  });
}

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
 * @returns {{embed: import('discord.js').EmbedBuilder|null, components: Array, resumable: boolean}}
 *   resumable is true when candidates remain and a Continue session holds them,
 *   so the pass is not finished.
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
  if (!altResult) return { embed: null, components: [], resumable: false };

  const guildName = meta?.guildName ?? altResult.target?.guildName;
  const { embed, state } = buildScanResultEmbed({
    target: { name, isHidden, guildName, profileUrl: rosterUrl(name) },
    result: altResult,
    kind: isHidden ? 'roster-hidden' : 'roster-visible',
    summaryLine: t('dialogue.enrich.summary', lang, { guild: guildName, name, resumed: '' }),
    lang,
  });
  if (!state.hasRemaining || !canContinue) return { embed, components: [], resumable: false };

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
  return { embed, components: buttonRow ? [buttonRow] : [], resumable: true };
}
