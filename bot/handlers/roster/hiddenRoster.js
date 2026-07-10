/**
 * handlers/roster/hiddenRoster.js
 * Hidden-roster branch of /la-roster · fired when the bible roster
 * page returns no characters (account is hidden). Renders the single
 * resolved character via fetchCharacterMeta, inlines any blacklist /
 * whitelist hit's evidence card so the operator sees it without
 * re-running /la-evidence, and offers the same deep-scan button as
 * the visible path.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { buildNameRosterQuery } from '../../utils/listEntryMap.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import {
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
  fetchNameSuggestions,
  formatSuggestionLines,
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
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { createRosterDeepSession } from '../../utils/rosterDeepSession.js';
import { rosterUrl, profileUrl as bibleProfileUrl } from '../../utils/rosterLink.js';
import { makeRosterScanProgressCallback, formatDeepScanStats } from './progress.js';

/**
 * Render the hidden-roster card for /la-roster.
 * @param {object} args
 * @param {import('discord.js').Interaction} args.interaction
 * @param {Function} args.replyEditor - shared editor function passed
 *   by command.js so this module doesn't need to know whether the
 *   reply has been deferred or not.
 * @param {string} args.name - the queried character name
 * @param {boolean} args.deep - whether the caller passed deep:true
 * @param {object} args.deepOptions - deep-scan tuning (concurrency,
 *   candidate cap, etc.) forwarded to detectAltsViaStronghold
 * @returns {Promise<void>}
 */
export async function handleHiddenRosterResult({ interaction, replyEditor, name, deep, deepOptions }) {
      await connectDB();
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
      // ── Hidden roster: try guild-based detection ──
      // Single-request probes (meta + guild list) allow ScraperAPI
      // fallback because they are 1 request each and bible direct can
      // flap; the high-fanout candidate scan downstream still keeps
      // ScraperAPI off via useScraperApiForCandidates.
      const meta = await fetchCharacterMeta(name, {
        timeoutMs: config.strongholdDeepCandidateTimeoutMs,
        viaWorker: true,
      });
      const hasGuild = meta && meta.guildName;

      if (hasGuild) {
        // Step 1: Get guild member list (fast, single request · ScraperAPI eligible)
        const guildMembers = await fetchGuildMembers(name, {
          timeoutMs: config.strongholdDeepCandidateTimeoutMs,
          cacheKey: meta.guildName,
          viaWorker: true,
        });
        const memberNames = guildMembers.map((m) => m.name);

        // Step 2: Quick DB check · are any guild members already in the lists?
        await connectDB();
        const rosterGuildId = interaction.guild?.id || '';
        const memberNameQuery = buildNameRosterQuery(memberNames);
        const [guildBlackHits, guildWhiteHits] = await Promise.all([
          Blacklist.find(buildBlacklistQuery(memberNameQuery, rosterGuildId))
            .collation({ locale: 'en', strength: 2 })
            .lean(),
          Whitelist.find(memberNameQuery)
            .collation({ locale: 'en', strength: 2 })
            .lean(),
        ]);

        // Step 3: Stronghold fingerprint scan for same-account alts.
        // This is intentionally gated behind deep:true because it can fan out
        // into hundreds of lostark.bible profile requests on large guilds.
        let altResult = null;
        let scanErrorEmbed = null;
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
          await replyEditor.edit({
            content: '',
            embeds: [buildScanProgressEmbed({
              title: t('dialogue.scan.progress', lang, { name }),
              subtitle: `${t('dialogue.scan.guildMembers', lang, { guild: meta.guildName, count: guildMembers.length })} · ${t('dialogue.scan.hiddenRoster', lang)}`,
              color: COLORS.info,
              lang,
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
            components: [buildStopButtonRow(sessionId, { lang })],
          }).catch(() => {});

          try {
            altResult = await detectAltsViaStronghold(name, {
              ...deepOptions,
              viaWorker: true,
              targetMeta: meta,
              guildMembers,
              cancelFlag,
              onProgress: makeRosterScanProgressCallback({
                interaction,
                replyEditor,
                name,
                meta,
                totalMembers: guildMembers.length,
                startedAtRef,
                lastEditRef,
                cancelFlag,
                sessionId,
                lang,
              }),
            });
          } catch (err) {
            scanErrorEmbed = buildAlertEmbed({
              severity: AlertSeverity.ERROR,
              ...t('dialogue.scan.stopped', lang, { name, reason: err.message || t('dialogue.scan.unexpectedError', lang) }),
              footer: t('dialogue.scan.stopped.rosterStillShown', lang),
              lang,
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
          t('dialogue.roster.hiddenStatus', lang, { guild: meta.guildName, count: guildMembers.length }),
          t('dialogue.roster.stronghold', lang, { stronghold: meta.strongholdName, strongholdLevel: meta.strongholdLevel, rosterLevel: meta.rosterLevel }),
        );

        if (!deep) {
          descriptionParts.push(
            '',
            t('dialogue.roster.noDeep', lang),
          );
        }

        if (guildBlackHits.length > 0) {
          descriptionParts.push(
            '',
            `**⛔ ${t('dialogue.roster.blackGuild', lang, { count: guildBlackHits.length })}**`,
            ...guildBlackHits.map(
              (e) => `⛔ **${e.name}** · ${e.reason || t('dialogue.roster.noReason', lang)}${e.raid ? ' [' + e.raid + ']' : ''}`
            ),
          );
        }

        if (guildWhiteHits.length > 0) {
          descriptionParts.push(
            '',
            `**✅ ${t('dialogue.roster.whiteGuild', lang, { count: guildWhiteHits.length })}**`,
            ...guildWhiteHits.map(
              (e) => `✅ **${e.name}** · ${e.reason || t('dialogue.roster.noReason', lang)}${e.raid ? ' [' + e.raid + ']' : ''}`
            ),
          );
        }

        const description = descriptionParts.join('\n');
        const hasBlack = guildBlackHits.length > 0;
        const hasWhite = guildWhiteHits.length > 0;
        const color = hasBlack ? COLORS.danger : hasWhite ? COLORS.success : COLORS.warning;
        const deepStats = formatDeepScanStats(altResult, lang);

        const primaryEmbed = createArtistEmbed(lang)
          .setTitle(`🔒 ${t('dialogue.roster.hiddenTitle', lang, { name })}`)
          .setURL(bibleProfileUrl(name))
          .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
          .setColor(color)
          .setFooter({
            text: t('dialogue.roster.guildFooter', lang, {
              count: guildMembers.length,
              word: t(`dialogue.roster.${guildMembers.length === 1 ? 'memberOne' : 'memberMany'}`, lang),
              stats: deepStats ? ` · ${deepStats}` : '',
            }),
          })
          .setTimestamp();

        // Build the second embed (scan result) and the Continue button
        // when deep ran. Continue lets the officer pick up where the
        // scan left off (cap-cut or Stop button) without re-running the
        // slash command from scratch.
        const replyEmbeds = [primaryEmbed];
        const replyComponents = [];
        let scanState = null;

        if (scanErrorEmbed) {
          replyEmbeds.push(scanErrorEmbed);
        } else if (deep && altResult) {
          const profileUrl = rosterUrl(name);
          const { embed: scanEmbed, state } = buildScanResultEmbed({
            target: { name, isHidden: true, guildName: meta.guildName, profileUrl },
            result: altResult,
            kind: 'roster-hidden',
            summaryLine: t('dialogue.enrich.summary', lang, { guild: meta.guildName, name, resumed: '' }),
            lang,
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
                scanned: altResult.scannedCandidates || 0,
                attempted: altResult.attemptedCandidates ?? altResult.scannedCandidates ?? 0,
                failed: altResult.failedCandidates || 0,
                rateLimitRetries: altResult.rateLimitRetries || 0,
              },
              primaryEmbedJSON: primaryEmbed.toJSON(),
            });
            const buttonRow = buildScanResultButtons({
              kind: 'roster',
              sessionId: session.sessionId,
              hasAlts: (altResult.alts || []).length > 0,
              hasRemaining: true,
              lang,
            });
            if (buttonRow) replyComponents.push(buttonRow);
          }
        }

        await replyEditor.edit({ embeds: replyEmbeds, components: replyComponents });

        // DM the caller when deep scan was run (long-running). Skip
        // for plain /la-roster which finishes in seconds.
        if (deep && altResult) {
          const replyMsg = replyEditor.getMessage();
          let outcome;
          if (altResult.cancelled || altResult.pausedForFailureStorm) {
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
            lang,
          }).catch(() => {});
        }
        return;
      }

      // No guild · show suggestions as before
      const suggestions = await fetchNameSuggestions(name) || [];
      const filtered = suggestions.filter((s) => s.itemLevel > 1700);
      if (filtered.length > 0) {
        await replyEditor.edit({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: t('dialogue.listAdd.noRoster.title', lang),
            description: t('dialogue.listAdd.noRoster.withSuggestions', lang, { name }),
            fields: [{ name: t('dialogue.listAdd.noRoster.suggestions', lang), value: formatSuggestionLines(filtered).slice(0, 1024), inline: false }],
            footer: t('dialogue.listAdd.noRoster.suggestionFooter', lang),
            lang,
          })],
        });
      } else {
        await replyEditor.edit({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.ERROR,
            title: t('dialogue.listAdd.noRoster.title', lang),
            description: t('dialogue.listAdd.noRoster.withoutSuggestions', lang, { name }),
            footer: t('dialogue.listAdd.noRoster.spellingFooter', lang),
            lang,
          })],
        });
      }
      return;

}
