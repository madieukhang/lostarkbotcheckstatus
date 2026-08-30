/**
 * handlers/roster/deepContinue.js
 * "Continue scan" button on the /la-roster deep-scan progress card.
 * Resumes the Stronghold alt-detection scan from where the previous
 * run paused (a /la-roster deep:true run hands off via a button when
 * the candidate window or time budget runs out).
 */

import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../db.js';
import UserPreference from '../../models/UserPreference.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { deferUpdate, replyAlert, replyEmbed } from '../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { detectAltsViaStronghold } from '../../services/roster/index.js';
import {
  buildScanResultEmbed,
  buildScanResultButtons,
} from '../../utils/scanResultEmbed.js';
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
import { createRosterScanRuntime } from './progress.js';
import { resolveRosterScanOutcome } from './completion.js';

function getSessionAccessAlert(session, userId, lang) {
  if (!session) {
    return { severity: AlertSeverity.WARNING, ...t('dialogue.scan.sessionExpired', lang), lang };
  }
  if (session.callerId !== userId) {
    return { severity: AlertSeverity.ERROR, ...t('dialogue.scan.notYourSession', lang), lang };
  }
  if (session.inProgress) {
    return { severity: AlertSeverity.INFO, ...t('dialogue.scan.continueRunning', lang), lang };
  }
  return null;
}

function countContinuationCandidates(session) {
  const excluded = new Set(
    (session.scannedNames || []).map((name) => String(name).toLowerCase())
  );
  return (session.guildMembers || []).filter((member) => (
    member.name !== session.targetName
    && member.ilvl >= 1700
    && !excluded.has(String(member.name).toLowerCase())
  )).length;
}

async function runContinuationPass({ interaction, replyEditor, session, reservation, primaryEmbed, lang }) {
  const activeScan = createRosterScanRuntime({
    interaction,
    replyEditor,
    name: session.targetName,
    meta: session.meta,
    totalMembers: session.guildMembers.length,
    label: `${session.targetName} (roster deep · resume)`,
    lang,
  });
  const eligible = countContinuationCandidates(session);
  const passLimit = session.cap || eligible;
  await replyEditor.edit(activeScan.buildInitialPayload({
    title: t('dialogue.scan.resuming', lang, { name: session.targetName }),
    subtitle: `${t('dialogue.scan.guildMembers', lang, {
      guild: session.meta.guildName,
      count: session.guildMembers.length,
    })} · ${t('dialogue.scan.continuePass', lang)}`,
    totalCandidates: Math.min(eligible, passLimit),
    content: null,
    leadingEmbeds: [primaryEmbed],
  })).catch(() => {});

  try {
    const result = await detectAltsViaStronghold(session.targetName, {
      targetMeta: session.meta,
      guildMembers: session.guildMembers,
      candidateLimit: session.cap,
      useScraperApiForCandidates: false,
      excludeNames: session.scannedNames || [],
      cancelFlag: activeScan.cancelFlag,
      viaWorker: true,
      onProgress: activeScan.onProgress,
    });
    return { result, error: null };
  } catch (error) {
    return { result: null, error };
  } finally {
    session.inProgress = false;
    refreshRosterDeepSession(session);
    activeScan.close();
    reservation.release();
  }
}

export function mergeContinuationScanResult(session, result) {
  const alts = mergeAltsByName(session.allDiscoveredAlts || [], result.alts || []);
  const scannedNames = [
    ...(session.scannedNames || []),
    ...(result.scannedNames || []),
  ];
  session.allDiscoveredAlts = alts;
  session.scannedNames = scannedNames;
  session.scanStats = {
    ...(session.scanStats || {}),
    scanned: (session.scanStats?.scanned ?? 0) + (result.scannedCandidates || 0),
    attempted: (session.scanStats?.attempted ?? 0)
      + (result.attemptedCandidates ?? result.scannedCandidates ?? 0),
    failed: (session.scanStats?.failed ?? 0) + (result.failedCandidates || 0),
    rateLimitRetries: (session.scanStats?.rateLimitRetries ?? 0) + (result.rateLimitRetries || 0),
  };

  return {
    ...result,
    scannedCandidates: session.scanStats.scanned ?? scannedNames.length,
    checkedCandidates: session.scanStats.scanned ?? scannedNames.length,
    attemptedCandidates: session.scanStats.attempted ?? scannedNames.length,
    failedCandidates: session.scanStats.failed,
    rateLimitRetries: session.scanStats.rateLimitRetries,
    alts,
    scannedNames,
  };
}

function buildContinuationPayload(session, cumulativeResult, primaryEmbed, lang) {
  const { embed: resultEmbed, state } = buildScanResultEmbed({
    target: {
      name: session.targetName,
      isHidden: session.isHidden,
      guildName: session.meta.guildName,
      profileUrl: rosterUrl(session.targetName),
    },
    result: cumulativeResult,
    kind: session.isHidden ? 'roster-hidden' : 'roster-visible',
    summaryLine: t('dialogue.enrich.summary', lang, {
      guild: session.meta.guildName,
      name: session.targetName,
      resumed: t('dialogue.enrich.resumed', lang),
    }),
    lang,
  });
  const components = [];
  if (state.hasRemaining) {
    const row = buildScanResultButtons({
      kind: 'roster',
      sessionId: session.sessionId,
      hasAlts: cumulativeResult.alts.length > 0,
      hasRemaining: true,
      lang,
    });
    if (row) components.push(row);
  } else {
    clearRosterDeepSession(session.sessionId);
  }
  return {
    payload: { content: null, embeds: [primaryEmbed, resultEmbed], components },
    hasRemaining: state.hasRemaining,
  };
}

function notifyContinuationCompletion({ interaction, replyEditor, session, result, hasRemaining, lang }) {
  const outcome = resolveRosterScanOutcome(result, { hasRemaining });
  if (!outcome) return;
  sendScanCompletionDm({
    user: interaction.user,
    commandLabel: '/la-roster deep · resume',
    scanTargetName: session.targetName,
    guildName: session.meta.guildName,
    channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
    resultMessageUrl: buildResultMessageUrl(interaction, replyEditor.getMessage()),
    outcome,
    result,
    lang,
  }).catch(() => {});
}

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
  const accessAlert = getSessionAccessAlert(session, interaction.user.id, lang);
  if (accessAlert) {
    await replyAlert(interaction, accessAlert);
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
  const primaryEmbed = EmbedBuilder.from(session.primaryEmbedJSON);
  const scan = await runContinuationPass({
    interaction,
    replyEditor,
    session,
    reservation: scanReservation,
    primaryEmbed,
    lang,
  });
  if (scan.error) {
    await replyEditor.edit({
      content: null,
      embeds: [
        primaryEmbed,
        buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          ...t('dialogue.scan.stopped', lang, {
            name: session.targetName,
            reason: scan.error.message || t('dialogue.scan.unexpectedError', lang),
          }),
          footer: t('dialogue.scan.stopped.retry', lang),
          lang,
        }),
      ],
      components: [],
    }).catch(() => {});
    return;
  }
  if (!scan.result) {
    await replyEditor.edit({
      content: null,
      embeds: [primaryEmbed],
      components: [],
    }).catch(() => {});
    return;
  }
  const cumulativeResult = mergeContinuationScanResult(session, scan.result);
  const rendered = buildContinuationPayload(session, cumulativeResult, primaryEmbed, lang);
  await replyEditor.edit(rendered.payload);
  notifyContinuationCompletion({
    interaction,
    replyEditor,
    session,
    result: cumulativeResult,
    hasRemaining: rendered.hasRemaining,
    lang,
  });
}
