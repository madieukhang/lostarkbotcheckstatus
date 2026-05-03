import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import {
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
  fetchNameSuggestions,
  formatSuggestionLines,
} from '../../services/rosterService.js';
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
import { createRosterDeepSession } from '../../utils/rosterDeepSession.js';
import { makeRosterScanProgressCallback, formatDeepScanStats } from './progress.js';

export async function handleHiddenRosterResult({ interaction, name, deep, deepOptions }) {
      // ── Hidden roster: try guild-based detection ──
      // Single-request probes (meta + guild list) allow ScraperAPI
      // fallback because they are 1 request each and bible direct can
      // flap; the high-fanout candidate scan downstream still keeps
      // ScraperAPI off via useScraperApiForCandidates.
      const meta = await fetchCharacterMeta(name, {
        timeoutMs: config.strongholdDeepCandidateTimeoutMs,
      });
      const hasGuild = meta && meta.guildName;

      if (hasGuild) {
        // Step 1: Get guild member list (fast, single request · ScraperAPI eligible)
        const guildMembers = await fetchGuildMembers(name, {
          timeoutMs: config.strongholdDeepCandidateTimeoutMs,
          cacheKey: meta.guildName,
        });
        const memberNames = guildMembers.map((m) => m.name);

        // Step 2: Quick DB check · are any guild members already in the lists?
        await connectDB();
        const rosterGuildId = interaction.guild?.id || '';
        const memberNameQuery = { $or: [{ name: { $in: memberNames } }, { allCharacters: { $in: memberNames } }] };
        const [guildBlackHits, guildWhiteHits] = await Promise.all([
          Blacklist.find(buildBlacklistQuery(memberNameQuery, rosterGuildId))
            .collation({ locale: 'en', strength: 2 })
            .lean(),
          Whitelist.find({
            $or: [
              { name: { $in: memberNames } },
              { allCharacters: { $in: memberNames } },
            ],
          })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
        ]);

        // Step 3: Stronghold fingerprint scan for same-account alts.
        // This is intentionally gated behind deep:true because it can fan out
        // into hundreds of lostark.bible profile requests on large guilds.
        let altResult = null;
        if (deep) {
          // Send a 0% progress embed + Stop button immediately so the
          // officer knows the scan started and has a way out if bible
          // is hot. onProgress edits the same message every 15s.
          const startedAtRef = { value: Date.now() };
          const lastEditRef = { value: startedAtRef.value };
          const filteredCount = guildMembers.filter((m) => m.name !== name && m.ilvl >= 1700).length;
          const cap = deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit;
          const sessionId = newScanSessionId();
          const cancelFlag = { cancelled: false };
          registerScan(sessionId, {
            cancelFlag,
            callerId: interaction.user.id,
            startedAt: startedAtRef.value,
            label: `${name} (roster deep · hidden)`,
          });
          await interaction.editReply({
            content: '',
            embeds: [buildScanProgressEmbed({
              title: `Stronghold scan in progress · ${name}`,
              subtitle: `Guild **${meta.guildName}** (${guildMembers.length} members) · hidden roster`,
              color: COLORS.info,
              progress: {
                scannedCandidates: 0,
                totalCandidates: Math.min(filteredCount, cap || filteredCount),
                altsFound: 0,
                failedCandidates: 0,
                currentBackoffMs: 1500,
                totalMembers: guildMembers.length,
                startedAt: startedAtRef.value,
              },
            })],
            components: [buildStopButtonRow(sessionId)],
          }).catch(() => {});

          try {
            altResult = await detectAltsViaStronghold(name, {
              ...deepOptions,
              targetMeta: meta,
              guildMembers,
              cancelFlag,
              onProgress: makeRosterScanProgressCallback({
                interaction,
                name,
                meta,
                totalMembers: guildMembers.length,
                startedAtRef,
                lastEditRef,
                cancelFlag,
                sessionId,
              }),
            });
          } finally {
            unregisterScan(sessionId);
          }
        }
        // Primary card: hidden roster info + guild list-hits. The alt
        // list moves to a separate scan-result embed below so a Continue
        // resume can re-render it without touching the primary card.
        const descriptionParts = [];
        descriptionParts.push(
          `Roster is hidden. Guild: **${meta.guildName}** (${guildMembers.length} members)`,
          `Stronghold: **${meta.strongholdName}** Lv.${meta.strongholdLevel} · Roster Lv.${meta.rosterLevel}`,
        );

        if (!deep) {
          descriptionParts.push(
            '',
            'Stronghold deep scan was not run. Use `deep:true` to scan same-account alts.',
          );
        }

        if (guildBlackHits.length > 0) {
          descriptionParts.push(
            '',
            `**⛔ Blacklisted guild members (${guildBlackHits.length}):**`,
            ...guildBlackHits.map(
              (e) => `⛔ **${e.name}** · ${e.reason || 'no reason'}${e.raid ? ' [' + e.raid + ']' : ''}`
            ),
          );
        }

        if (guildWhiteHits.length > 0) {
          descriptionParts.push(
            '',
            `**✅ Whitelisted guild members (${guildWhiteHits.length}):**`,
            ...guildWhiteHits.map(
              (e) => `✅ **${e.name}** · ${e.reason || 'no reason'}${e.raid ? ' [' + e.raid + ']' : ''}`
            ),
          );
        }

        const description = descriptionParts.join('\n');
        const hasBlack = guildBlackHits.length > 0;
        const hasWhite = guildWhiteHits.length > 0;
        const color = hasBlack ? COLORS.danger : hasWhite ? COLORS.success : COLORS.warning;
        const deepStats = formatDeepScanStats(altResult);

        const primaryEmbed = new EmbedBuilder()
          .setTitle(`Hidden Roster – ${name}`)
          .setURL(`https://lostark.bible/character/NA/${encodeURIComponent(name)}`)
          .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
          .setColor(color)
          .setFooter({ text: `${guildMembers.length} guild members${deepStats ? ` · ${deepStats}` : ''} · lostark.bible` })
          .setTimestamp();

        // Build the second embed (scan result) and the Continue button
        // when deep ran. Continue lets the officer pick up where the
        // scan left off (cap-cut or Stop button) without re-running the
        // slash command from scratch.
        const replyEmbeds = [primaryEmbed];
        const replyComponents = [];
        let scanState = null;

        if (deep && altResult) {
          const profileUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
          const { embed: scanEmbed, state } = buildScanResultEmbed({
            target: { name, isHidden: true, guildName: meta.guildName, profileUrl },
            result: altResult,
            kind: 'roster-hidden',
            summaryLine: `I scanned **${meta.guildName}** for stronghold matches with **${name}**.`,
          });
          scanState = state;
          replyEmbeds.push(scanEmbed);

          if (state.hasRemaining) {
            const session = createRosterDeepSession({
              callerId: interaction.user.id,
              targetName: name,
              isHidden: true,
              meta,
              guildMembers,
              scannedNames: altResult.scannedNames || [],
              allDiscoveredAlts: altResult.alts || [],
              cap: deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit,
              scanStats: {
                failed: altResult.failedCandidates || 0,
              },
              primaryEmbedJSON: primaryEmbed.toJSON(),
              contentText: '',
            });
            const buttonRow = buildScanResultButtons({
              kind: 'roster',
              sessionId: session.sessionId,
              hasAlts: (altResult.alts || []).length > 0,
              hasRemaining: true,
            });
            if (buttonRow) replyComponents.push(buttonRow);
          }
        }

        await interaction.editReply({ embeds: replyEmbeds, components: replyComponents });

        // DM the caller when deep scan was run (long-running). Skip
        // for plain /la-roster which finishes in seconds.
        if (deep && altResult) {
          const replyMsg = await interaction.fetchReply().catch(() => null);
          let outcome;
          if (altResult.cancelled) {
            outcome = altResult.alts.length > 0 ? 'stopped-with-alts' : 'stopped-no-alts';
          } else {
            outcome = altResult.alts.length > 0 ? 'completed' : 'no-alts';
          }
          sendScanCompletionDm({
            user: interaction.user,
            commandLabel: '/la-roster deep',
            scanTargetName: name,
            guildName: meta?.guildName,
            channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
            resultMessageUrl: buildResultMessageUrl(interaction, replyMsg),
            outcome,
            result: altResult,
          }).catch(() => {});
        }
        return;
      }

      // No guild · show suggestions as before
      const suggestions = await fetchNameSuggestions(name) || [];
      const filtered = suggestions.filter((s) => s.itemLevel > 1700);
      if (filtered.length > 0) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'No Roster Found',
            description: `No character named **${name}** was found on lostark.bible. Similar names:`,
            fields: [{ name: 'Suggestions', value: formatSuggestionLines(filtered).slice(0, 1024), inline: false }],
            footer: 'Pick one of the suggested names and re-run the command.',
          })],
        });
      } else {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: 'No Roster Found',
            description: `No character named **${name}** was found on lostark.bible.`,
            footer: 'Check the spelling (LA names are case-sensitive and may include diacritics).',
          })],
        });
      }
      return;

}
