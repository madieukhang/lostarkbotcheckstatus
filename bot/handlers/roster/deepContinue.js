import { EmbedBuilder } from 'discord.js';

import config from '../../config.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { detectAltsViaStronghold } from '../../services/rosterService.js';
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
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { createLongRunningReplyEditor } from '../../utils/longRunningReply.js';
import {
  getRosterDeepSession,
  refreshRosterDeepSession,
  clearRosterDeepSession,
} from '../../utils/rosterDeepSession.js';
import { makeRosterScanProgressCallback } from './progress.js';

/**
 * Continue button for /la-roster deep:true. Resumes the prior scan with
 * scanned-names fed back as excludeNames so the next pass walks only
 * fresh candidates. Reuses cached meta + guildMembers from the session
 * so we do not pay another roster-page fetch for the resume.
 *
 * customId shape: `roster-deep:continue:<sessionId>`
 */
export async function handleRosterDeepContinueButton(interaction) {
  const sessionId = interaction.customId.split(':')[2];
  const session = getRosterDeepSession(sessionId);
  if (!session) {
    await interaction.reply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Session Expired',
        description: 'This deep-scan session is older than the 5-minute window.',
        footer: 'Re-run /la-roster deep:true to start a fresh scan.',
      })],
      ephemeral: true,
    });
    return;
  }
  if (session.callerId !== interaction.user.id) {
    await interaction.reply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.ERROR,
        title: 'Not Your Session',
        description: 'Only the officer who started this scan can continue it.',
      })],
      ephemeral: true,
    });
    return;
  }
  if (session.inProgress) {
    await interaction.reply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.INFO,
        title: 'Scan Already Running',
        description: 'A Continue pass is already running for this result card. Wait for it to finish before clicking again.',
      })],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferUpdate();
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

  // Show progress embed during the resume pass. We replace the result
  // card temporarily; on completion the result card is rebuilt and
  // posted alongside the cached primary embed snapshot.
  const excludeSet = new Set((session.scannedNames || []).map((n) => String(n).toLowerCase()));
  const passEligible = (session.guildMembers || [])
    .filter((m) => m.name !== session.targetName && m.ilvl >= 1700 && !excludeSet.has(String(m.name).toLowerCase()))
    .length;
  const passLimit = session.cap || passEligible;

  const progressEmbed = buildScanProgressEmbed({
    title: `Stronghold scan resuming · ${session.targetName}`,
    subtitle: `Guild **${session.meta.guildName}** (${session.guildMembers.length} members) · Continue pass`,
    color: COLORS.info,
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
    content: session.contentText || '',
    embeds: [primaryEmbed, progressEmbed],
    components: [buildStopButtonRow(scanSessionId)],
  }).catch(() => {});

  let altResult;
  try {
    altResult = await detectAltsViaStronghold(session.targetName, {
      targetMeta: session.meta,
      guildMembers: session.guildMembers,
      candidateLimit: session.cap,
      useScraperApiForCandidates: false,
      excludeNames: session.scannedNames || [],
      cancelFlag,
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
      }),
    });
  } finally {
    session.inProgress = false;
    refreshRosterDeepSession(session);
    unregisterScan(scanSessionId);
  }

  if (!altResult) {
    await replyEditor.edit({
      content: session.contentText || '',
      embeds: [primaryEmbed],
      components: [],
    }).catch(() => {});
    return;
  }

  // Merge cumulative scan state into the session for the next Continue.
  const mergedAlts = mergeRosterAlts(session.allDiscoveredAlts || [], altResult.alts || []);
  const mergedScannedNames = [
    ...(session.scannedNames || []),
    ...(altResult.scannedNames || []),
  ];
  session.allDiscoveredAlts = mergedAlts;
  session.scannedNames = mergedScannedNames;
  session.scanStats = {
    ...(session.scanStats || {}),
    failed: (session.scanStats?.failed ?? 0) + (altResult.failedCandidates || 0),
    rateLimitRetries: (session.scanStats?.rateLimitRetries ?? 0) + (altResult.rateLimitRetries || 0),
  };

  // Cumulative result for display: invariants from the latest pass,
  // counts grown across passes.
  const cumulativeResult = {
    ...altResult,
    scannedCandidates: mergedScannedNames.length,
    failedCandidates: session.scanStats.failed,
    rateLimitRetries: session.scanStats.rateLimitRetries,
    alts: mergedAlts,
    scannedNames: mergedScannedNames,
  };

  const profileUrl = `https://lostark.bible/character/NA/${encodeURIComponent(session.targetName)}/roster`;
  const { embed: resultEmbed, state } = buildScanResultEmbed({
    target: { name: session.targetName, isHidden: session.isHidden, guildName: session.meta.guildName, profileUrl },
    result: cumulativeResult,
    kind: session.isHidden ? 'roster-hidden' : 'roster-visible',
    summaryLine: `Resumed scan of **${session.meta.guildName}** for stronghold matches with **${session.targetName}**.`,
  });

  const components = [];
  if (state.hasRemaining) {
    const buttonRow = buildScanResultButtons({
      kind: 'roster',
      sessionId: session.sessionId,
      hasAlts: mergedAlts.length > 0,
      hasRemaining: true,
    });
    if (buttonRow) components.push(buttonRow);
  } else {
    // Fully scanned. Drop the session so memory does not leak the
    // cached guildMembers array.
    clearRosterDeepSession(session.sessionId);
  }

  await replyEditor.edit({
    content: session.contentText || '',
    embeds: [primaryEmbed, resultEmbed],
    components,
  });

  // DM only on terminal states (fully scanned or cancelled). Mid-scan
  // continues do not warrant a fresh DM ping.
  let outcome = null;
  if (altResult.cancelled) {
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
    }).catch(() => {});
  }
}

/**
 * Local merge helper used by the roster-deep Continue resume. Same
 * shape as enrich/index.js#mergeAltsByName but kept private here to
 * avoid a circular import (enrich is the only other caller and lives
 * under handlers/list/).
 */
function mergeRosterAlts(prior, next) {
  const byName = new Map();
  for (const alt of prior) byName.set(String(alt.name).toLowerCase(), alt);
  for (const alt of next) byName.set(String(alt.name).toLowerCase(), alt);
  return Array.from(byName.values());
}
