/**
 * handlers/roster/visibleDeepScan.js
 * Visible-roster branch of /la-roster deep:true · runs the Stronghold
 * alt-detection scan, throttled via makeRosterScanProgressCallback,
 * and renders the final scan-result card. The hidden-roster path has
 * its own scan branch in hiddenRoster.js; both share the progress +
 * scan-session primitives in utils/scanProgressEmbed + scanSession.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import UserPreference from '../../models/UserPreference.js';
import { COLORS } from '../../utils/ui.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import {
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
} from '../../services/roster/index.js';
import { buildScanProgressEmbed } from '../../utils/scanProgressEmbed.js';
import {
  buildScanResultEmbed,
  buildScanResultButtons,
} from '../../utils/scanResultEmbed.js';
import {
  buildStopButtonRow,
  newScanSessionId,
  registerScan,
  unregisterScan,
} from '../../utils/scanSession.js';
import { createRosterDeepSession } from '../../utils/rosterDeepSession.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { makeRosterScanProgressCallback } from './progress.js';

/**
 * Run the Stronghold deep-scan branch on a visible /la-roster query.
 * @param {object} args
 * @param {import('discord.js').Interaction} args.interaction
 * @param {Function} args.replyEditor - shared editor (see other roster
 *   handlers for the same pattern)
 * @param {string} args.name - the queried character name
 * @param {object} args.deepOptions - scan tuning (concurrency,
 *   candidate cap, backoff bounds)
 * @param {import('discord.js').EmbedBuilder} args.embed - the base
 *   embed the caller already started (visible-roster card); this
 *   function appends the deep-scan section.
 * @param {string[]} args.contentLines - lines accumulated by the
 *   caller; this function appends scan progress + result lines.
 * @returns {Promise<void>}
 */
export async function runVisibleRosterDeepScan({ interaction, replyEditor, name, deepOptions, embed, contentLines }) {
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    // Visible-roster deep scan: hoist these to the function scope so
    // the post-editReply DM block at the bottom can reference them.
    let visibleDeepResult = null;
    let visibleDeepMeta = null;
    let visibleDeepGuildMembers = null;
    // Components added by the deep-scan path (Continue button when
    // remaining > 0). Empty when deep was off or fully scanned.
    const deepScanComponents = [];
    // Second embed (scan result card) appended to the reply when deep ran.
    let deepScanResultEmbed = null;

    // Deep scan: Stronghold alt detection even when roster is visible
      try {
        // Pre-fetch meta + guild members so we can render an initial
        // progress embed with guild context (member count, name) before
        // the candidate fan-out starts. The detector skips its own
        // internal target/guild fetches when both are pre-supplied.
        const visMeta = await fetchCharacterMeta(name, {
          timeoutMs: config.strongholdDeepCandidateTimeoutMs,
          viaWorker: true,
        });
        const visGuildMembers = visMeta?.guildName
          ? await fetchGuildMembers(name, {
              timeoutMs: config.strongholdDeepCandidateTimeoutMs,
              cacheKey: visMeta.guildName,
              viaWorker: true,
            })
          : [];

        const startedAtRef = { value: Date.now() };
        const lastEditRef = { value: startedAtRef.value };
        const visFilteredCount = visGuildMembers.filter((m) => m.name !== name && m.ilvl >= 1700).length;
        const visCap = deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit;
        // Single progress embed during the scan; the final editReply at
        // the bottom of this branch replaces it with the full
        // content + embeds payload (main roster card + evidence + deep
        // scan addFields). User trade-off: loses the in-progress glimpse
        // of the main roster card, but it was never rendered before the
        // scan anyway so nothing is actually lost.
        const hasGuildContext = visMeta?.guildName && visGuildMembers.length > 0;
        const sessionId = hasGuildContext ? newScanSessionId() : null;
        const cancelFlag = hasGuildContext ? { cancelled: false } : null;
        if (hasGuildContext) {
          registerScan(sessionId, {
            cancelFlag,
            callerId: interaction.user.id,
            startedAt: startedAtRef.value,
            label: `${name} (roster deep · visible)`,
          });
          await replyEditor.edit({
            content: '',
            embeds: [buildScanProgressEmbed({
              title: t('dialogue.scan.progress', lang, { name }),
              subtitle: `${t('dialogue.scan.guildMembers', lang, { guild: visMeta.guildName, count: visGuildMembers.length })} · ${t('dialogue.scan.visibleRoster', lang)}`,
              color: COLORS.info,
              lang,
              progress: {
                scannedCandidates: 0,
                totalCandidates: Math.min(visFilteredCount, visCap || visFilteredCount),
                altsFound: 0,
                failedCandidates: 0,
                currentBackoffMs: 1500,
                totalMembers: visGuildMembers.length,
                startedAt: startedAtRef.value,
              },
            })],
            components: [buildStopButtonRow(sessionId, { lang })],
          }).catch(() => {});
        }

        let altResult;
        try {
          altResult = await detectAltsViaStronghold(name, {
            ...deepOptions,
            viaWorker: true,
            ...(visMeta ? { targetMeta: visMeta } : {}),
            ...(visGuildMembers.length > 0 ? { guildMembers: visGuildMembers } : {}),
            ...(cancelFlag ? { cancelFlag } : {}),
            onProgress: hasGuildContext
              ? makeRosterScanProgressCallback({
                  interaction,
                  replyEditor,
                  name,
                  meta: visMeta,
                  totalMembers: visGuildMembers.length,
                  startedAtRef,
                  lastEditRef,
                  cancelFlag,
                  sessionId,
                  lang,
                })
              : undefined,
          });
        } finally {
          if (sessionId) unregisterScan(sessionId);
        }
        // Surface deep-scan result to the function scope for the
        // post-reply DM. visMeta gives the DM access to guildName.
        visibleDeepResult = altResult;
        visibleDeepMeta = visMeta;
        visibleDeepGuildMembers = visGuildMembers;

        // Render the deep-scan result as a separate embed so a Continue
        // resume can re-edit it without rebuilding the visible roster
        // card. The visible-roster deep path is opt-in (deep:true) so
        // we know the officer wants the alt list visible.
        if (altResult && visMeta?.guildName) {
          const profileUrl = rosterUrl(name);
          const { embed: scanEmbed, state } = buildScanResultEmbed({
            target: { name, isHidden: false, guildName: visMeta.guildName, profileUrl },
            result: altResult,
            kind: 'roster-visible',
            summaryLine: t('dialogue.enrich.summary', lang, { guild: visMeta.guildName, name, resumed: '' }),
            lang,
          });
          deepScanResultEmbed = scanEmbed;

          if (state.hasRemaining && hasGuildContext) {
            const session = createRosterDeepSession({
              callerId: interaction.user.id,
              targetName: name,
              isHidden: false,
              meta: visMeta,
              guildMembers: visGuildMembers,
              scannedNames: altResult.scannedNames || [],
              allDiscoveredAlts: altResult.alts || [],
              cap: deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit,
              scanStats: {
                scanned: altResult.scannedCandidates || 0,
                attempted: altResult.attemptedCandidates ?? altResult.scannedCandidates ?? 0,
                failed: altResult.failedCandidates || 0,
                rateLimitRetries: altResult.rateLimitRetries || 0,
              },
              // primaryEmbedJSON captured AFTER editReply below; we
              // overwrite it here with the working embed snapshot so
              // a Continue click can re-render the same card without
              // re-scraping the visible roster page.
              primaryEmbedJSON: embed.toJSON(),
              contentText: contentLines.length > 0 ? contentLines.join('\n') : '',
            });
            const buttonRow = buildScanResultButtons({
              kind: 'roster',
              sessionId: session.sessionId,
              hasAlts: (altResult.alts || []).length > 0,
              hasRemaining: true,
              lang,
            });
            if (buttonRow) deepScanComponents.push(buttonRow);
          }
        } else if (altResult) {
          // No guild context (visible roster but no guild on bible).
          // Render scan result anyway with whatever we have so officer
          // sees outcome. No Continue button (nothing to resume against
          // without a guild member list).
          const { embed: scanEmbed } = buildScanResultEmbed({
            target: { name, isHidden: false, guildName: visMeta?.guildName, profileUrl: rosterUrl(name) },
            result: altResult,
            kind: 'roster-visible',
            summaryLine: t('dialogue.enrich.noGuild.description', lang, { name }),
            lang,
          });
          deepScanResultEmbed = scanEmbed;
        }
      } catch (err) {
        deepScanResultEmbed = createArtistEmbed(lang)
          .setTitle(`❌ ${t('dialogue.scan.failed.title', lang, { name })}`)
          .setDescription(t('dialogue.scan.failed.description', lang, { error: err.message }))
          .setColor(COLORS.danger)
          .setTimestamp();
      }


  return {
    resultEmbed: deepScanResultEmbed,
    components: deepScanComponents,
    result: visibleDeepResult,
    meta: visibleDeepMeta,
    guildMembers: visibleDeepGuildMembers,
  };
}
