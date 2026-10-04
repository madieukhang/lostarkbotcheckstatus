/**
 * handlers/roster/visibleDeepScan.js
 * Visible-roster branch of /la-roster deep:true · runs the Stronghold
 * alt-detection scan, throttled via createRosterScanRuntime,
 * and renders the final scan-result card. The hidden-roster path has
 * its own scan branch in hiddenRoster.js; both share the progress +
 * scan-session primitives in utils/scanProgressEmbed + scanSession.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import { MIN_TRACKED_ITEM_LEVEL } from '../../config/itemLevelThreshold.js';
import UserPreference from '../../models/UserPreference.js';
import { COLORS } from '../../utils/ui.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import {
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
} from '../../services/roster/index.js';
import { createRosterScanRuntime } from './progress.js';
import { buildRosterDeepScanResult } from './deepResult.js';

/**
 * Run the Stronghold deep-scan branch on a visible /la-roster query.
 * @param {object} args
 * @param {import('discord.js').Interaction} args.interaction
 * @param {{edit: Function, getMessage: Function}} args.replyEditor - the
 *   createLongRunningReplyEditor object shared with the other roster handlers
 * @param {string} args.name - the queried character name
 * @param {{candidateLimit?: number, useScraperApiForCandidates: boolean}} args.deepOptions -
 *   forwarded to detectAltsViaStronghold
 * @param {import('discord.js').EmbedBuilder} args.embed - the base
 *   embed the caller already started (visible-roster card); this
 *   function appends the deep-scan section.
 * @returns {Promise<object>} Result card, continuation controls, and scan context.
 */
export async function runVisibleRosterDeepScan({ interaction, replyEditor, name, deepOptions, embed }) {
  await connectDB();
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
  // Returned to the caller, which sends the completion DM from them.
  let visibleDeepResult = null;
  let visibleDeepMeta = null;
  // Components added by the deep-scan path (Continue button when
  // remaining > 0). Empty when deep was off or fully scanned.
  const deepScanComponents = [];
  // Second embed (scan result card) appended to the reply when deep ran.
  let deepScanResultEmbed = null;

  // Deep scan: Stronghold alt detection even when roster is visible
  try {
    // Pre-fetch meta + guild members to render an initial progress embed
    // with guild context (member count, name) before
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

    const visFilteredCount = visGuildMembers.filter((m) => m.name !== name && m.ilvl >= MIN_TRACKED_ITEM_LEVEL).length;
    const visCap = deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit;
    // Single progress embed during the scan; the caller's final edit
    // replaces it with the roster card and this scan's result card.
    const hasGuildContext = visMeta?.guildName && visGuildMembers.length > 0;
    const scan = hasGuildContext
      ? createRosterScanRuntime({
        interaction,
        replyEditor,
        name,
        meta: visMeta,
        totalMembers: visGuildMembers.length,
        label: `${name} (roster deep · visible)`,
        lang,
      })
      : null;
    if (scan) {
      await replyEditor.edit(
        scan.buildInitialPayload({
          title: t('dialogue.scan.progress', lang, { name }),
          subtitle: `${t('dialogue.scan.guildMembers', lang, { guild: visMeta.guildName, count: visGuildMembers.length })} · ${t('dialogue.scan.visibleRoster', lang)}`,
          totalCandidates: Math.min(visFilteredCount, visCap || visFilteredCount),
        })
      ).catch(() => {});
    }

    let altResult;
    try {
      altResult = await detectAltsViaStronghold(name, {
        ...deepOptions,
        viaWorker: true,
        ...(visMeta ? { targetMeta: visMeta } : {}),
        ...(visGuildMembers.length > 0 ? { guildMembers: visGuildMembers } : {}),
        ...(scan ? { cancelFlag: scan.cancelFlag } : {}),
        onProgress: scan?.onProgress,
      });
    } finally {
      scan?.close();
    }
    // visMeta gives the completion DM access to guildName.
    visibleDeepResult = altResult;
    visibleDeepMeta = visMeta;

    // A visible scan without guild members can render but cannot resume.
    const rendered = buildRosterDeepScanResult({
      callerId: interaction.user.id,
      name,
      isHidden: false,
      meta: visMeta,
      guildMembers: visGuildMembers,
      altResult,
      cap: deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit,
      primaryEmbed: embed,
      canContinue: Boolean(hasGuildContext),
      lang,
    });
    deepScanResultEmbed = rendered.embed;
    deepScanComponents.push(...rendered.components);
  } catch (err) {
    deepScanResultEmbed = createArtistEmbed()
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
  };
}
