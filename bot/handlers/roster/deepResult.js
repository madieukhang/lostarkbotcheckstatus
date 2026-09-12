import { t } from '../../services/i18n/index.js';
import { createRosterContinuationSession } from '../../utils/rosterDeepSession.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildScanResultEmbed, buildScanResultButtons } from '../../utils/scanResultEmbed.js';

/**
 * Render a roster deep-scan result and register its Continue session if allowed.
 * Callers retain their guild-context gate; the primary card snapshot and scan
 * totals must come from the same pass so Continue can resume without scraping.
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
