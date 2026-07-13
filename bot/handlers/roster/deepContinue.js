/**
 * handlers/roster/deepContinue.js
 * "Continue scan" button on the /la-roster deep-scan progress card.
 * Resumes the Stronghold alt-detection scan from where the previous
 * run paused (a /la-roster deep:true run hands off via a button when
 * the candidate window or time budget runs out).
 */

import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import UserPreference from '../../models/UserPreference.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { deferUpdate, replyAlert, replyEmbed } from '../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { detectAltsViaStronghold } from '../../services/roster/index.js';
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
import {
  buildStrongholdScanLimitEmbed,
  reserveStrongholdScanForInteraction,
} from '../../utils/strongholdScanGate.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { createLongRunningReplyEditor } from '../../utils/longRunningReply.js';
import { mergeAltsByName } from '../../utils/alts.js';
import {
  getRosterDeepSession,
  refreshRosterDeepSession,
  clearRosterDeepSession,
} from '../../utils/rosterDeepSession.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { makeRosterScanProgressCallback } from './progress.js';

/**
 * Continue button for /la-roster deep:true. Resumes the prior scan
 * with scanned-names fed back as excludeNames so the next pass walks
 * only fresh candidates. Cached meta + guildMembers from the session avoid
 * another roster-page fetch during resume.
 * Officer/senior-only.
 *
 * customId shape: `roster-deep:continue:<sessionId>`
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<void>}
 */
export async function handleRosterDeepContinueButton(interaction) {
  await connectDB();
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
  const sessionId = interaction.customId.split(':')[2];
  const session = getRosterDeepSession(sessionId);
  if (!session) {
    await replyAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.scan.sessionExpired', lang),
      lang,
    });
    return;
  }
  if (session.callerId !== interaction.user.id) {
    await replyAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.scan.notYourSession', lang),
      lang,
    });
    return;
  }
  if (session.inProgress) {
    await replyAlert(interaction, {
      severity: AlertSeverity.INFO,
      ...t('dialogue.scan.continueRunning', lang),
      lang,
    });
    return;
  }

  const scanReservation = reserveStrongholdScanForInteraction(interaction, `/la-roster deep continue ${session.targetName}`);
  if (!scanReservation.ok) {
    await replyEmbed(interaction, buildStrongholdScanLimitEmbed(scanReservation.active, lang));
    return;
  }

  await deferUpdate(interaction).catch((err) => {
    scanReservation.release();
    throw err;
  });
  const replyEditor = createLongRunningReplyEditor(interaction);
  session.inProgress = true;
  refreshRosterDeepSession(session);

  const startedAtRef = { value: Date.now() };
  const lastEditRef = { value: startedAtRef.value };
  const scanSessionId = newScanSessionId();
  const cancelFlag = { cancelled: false };
  registerScan(scanSessionId, {
    cancelFlag,
    callerId: interaction.user.id,
    startedAt: startedAtRef.value,
    label: `${session.targetName} (roster deep · resume)`,
  });

  // Show the progress embed during the resume pass. It temporarily replaces
  // the result card; on completion the result card is rebuilt and
  // posted alongside the cached primary embed snapshot.
  const excludeSet = new Set((session.scannedNames || []).map((n) => String(n).toLowerCase()));
  const passEligible = (session.guildMembers || [])
    .filter((m) => m.name !== session.targetName && m.ilvl >= 1700 && !excludeSet.has(String(m.name).toLowerCase()))
    .length;
  const passLimit = session.cap || passEligible;

  const progressEmbed = buildScanProgressEmbed({
    title: t('dialogue.scan.resuming', lang, { name: session.targetName }),
    subtitle: `${t('dialogue.scan.guildMembers', lang, { guild: session.meta.guildName, count: session.guildMembers.length })} · ${t('dialogue.scan.continuePass', lang)}`,
    color: COLORS.info,
    lang,
    progress: {
      scannedCandidates: 0,
      totalCandidates: Math.min(passEligible, passLimit),
      altsFound: 0,
      failedCandidates: 0,
      currentBackoffMs: 1500,
      totalMembers: session.guildMembers.length,
      startedAt: startedAtRef.value,
    },
  });

  const primaryEmbed = EmbedBuilder.from(session.primaryEmbedJSON);
  await replyEditor.edit({
    content: null,
    embeds: [primaryEmbed, progressEmbed],
    components: [buildStopButtonRow(scanSessionId, { lang })],
  }).catch(() => {});

  let altResult;
  let scanThrownError = null;
  try {
    altResult = await detectAltsViaStronghold(session.targetName, {
      targetMeta: session.meta,
      guildMembers: session.guildMembers,
      candidateLimit: session.cap,
      useScraperApiForCandidates: false,
      excludeNames: session.scannedNames || [],
      cancelFlag,
      viaWorker: true,
      onProgress: makeRosterScanProgressCallback({
        interaction,
        replyEditor,
        name: session.targetName,
        meta: session.meta,
        totalMembers: session.guildMembers.length,
        startedAtRef,
        lastEditRef,
        cancelFlag,
        sessionId: scanSessionId,
        lang,
      }),
    });
  } catch (err) {
    scanThrownError = err;
  } finally {
    session.inProgress = false;
    refreshRosterDeepSession(session);
    unregisterScan(scanSessionId);
    scanReservation.release();
  }

  if (scanThrownError) {
    await replyEditor.edit({
      content: null,
      embeds: [
        primaryEmbed,
        buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.scan.stopped', lang, { name: session.targetName, reason: scanThrownError.message || t('dialogue.scan.unexpectedError', lang) }),
          footer: t('dialogue.scan.stopped.retry', lang),
          lang,
        }),
      ],
      components: [],
    }).catch(() => {});
    return;
  }

  if (!altResult) {
    await replyEditor.edit({
      content: null,
      embeds: [primaryEmbed],
      components: [],
    }).catch(() => {});
    return;
  }

  // Merge cumulative scan state into the session for the next Continue.
  const mergedAlts = mergeAltsByName(session.allDiscoveredAlts || [], altResult.alts || []);
  const mergedScannedNames = [
    ...(session.scannedNames || []),
    ...(altResult.scannedNames || []),
  ];
  session.allDiscoveredAlts = mergedAlts;
  session.scannedNames = mergedScannedNames;
  session.scanStats = {
    ...(session.scanStats || {}),
    scanned: (session.scanStats?.scanned ?? 0) + (altResult.scannedCandidates || 0),
    attempted:
      (session.scanStats?.attempted ?? 0) +
      (altResult.attemptedCandidates ?? altResult.scannedCandidates ?? 0),
    failed: (session.scanStats?.failed ?? 0) + (altResult.failedCandidates || 0),
    rateLimitRetries: (session.scanStats?.rateLimitRetries ?? 0) + (altResult.rateLimitRetries || 0),
  };

  // Cumulative result for display: invariants from the latest pass,
  // counts grown across passes.
  const cumulativeResult = {
    ...altResult,
    scannedCandidates: session.scanStats.scanned ?? mergedScannedNames.length,
    checkedCandidates: session.scanStats.scanned ?? mergedScannedNames.length,
    attemptedCandidates: session.scanStats.attempted ?? mergedScannedNames.length,
    failedCandidates: session.scanStats.failed,
    rateLimitRetries: session.scanStats.rateLimitRetries,
    alts: mergedAlts,
    scannedNames: mergedScannedNames,
  };

  const profileUrl = rosterUrl(session.targetName);
  const { embed: resultEmbed, state } = buildScanResultEmbed({
    target: { name: session.targetName, isHidden: session.isHidden, guildName: session.meta.guildName, profileUrl },
    result: cumulativeResult,
    kind: session.isHidden ? 'roster-hidden' : 'roster-visible',
    summaryLine: t('dialogue.enrich.summary', lang, { guild: session.meta.guildName, name: session.targetName, resumed: t('dialogue.enrich.resumed', lang) }),
    lang,
  });

  const components = [];
  if (state.hasRemaining) {
    const buttonRow = buildScanResultButtons({
      kind: 'roster',
      sessionId: session.sessionId,
      hasAlts: mergedAlts.length > 0,
      hasRemaining: true,
      lang,
    });
    if (buttonRow) components.push(buttonRow);
  } else {
    // Fully scanned. Drop the session so memory does not leak the
    // cached guildMembers array.
    clearRosterDeepSession(session.sessionId);
  }

  await replyEditor.edit({
    content: null,
    embeds: [primaryEmbed, resultEmbed],
    components,
  });

  // DM only on terminal states (fully scanned or cancelled). Mid-scan
  // continues do not warrant a fresh DM ping.
  let outcome = null;
  if (altResult.cancelled || altResult.pausedForFailureStorm) {
    outcome = mergedAlts.length > 0 ? 'stopped-with-alts' : 'stopped-no-alts';
  } else if (!state.hasRemaining) {
    outcome = mergedAlts.length > 0 ? 'completed' : 'no-alts';
  }
  if (outcome) {
    const replyMsg = replyEditor.getMessage();
    sendScanCompletionDm({
      user: interaction.user,
      commandLabel: '/la-roster deep · resume',
      scanTargetName: session.targetName,
      guildName: session.meta.guildName,
      channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
      resultMessageUrl: buildResultMessageUrl(interaction, replyMsg),
      outcome,
      result: cumulativeResult,
      lang,
    }).catch(() => {});
  }
}
