import { EmbedBuilder } from 'discord.js';
import { JSDOM, VirtualConsole } from 'jsdom';

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => {});
virtualConsole.on('jsdomError', (err) => {
  if (err?.type === 'css parsing') return;
  console.warn('[jsdom] Parse warning:', err?.message || err);
});

import { connectDB } from '../db.js';
import config from '../config.js';
import { buildBlacklistQuery } from '../utils/scope.js';
import { COLORS } from '../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../utils/alertEmbed.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import TrustedUser from '../models/TrustedUser.js';
import RosterSnapshot from '../models/RosterSnapshot.js';
import {
  FETCH_HEADERS,
  fetchWithFallback,
  parseRosterCharactersFromHtml,
  fetchNameSuggestions,
  formatSuggestionLines,
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
} from '../services/rosterService.js';
import { getClassName } from '../models/Class.js';
import { getAddedByDisplay, normalizeCharacterName } from '../utils/names.js';
import { resolveDisplayImageUrl } from '../utils/imageRehost.js';
import { buildScanProgressEmbed } from '../utils/scanProgressEmbed.js';

// Discord webhook edits are rate-limited (5 per 5s). 30s throttle gives
// ~10-14 progress updates over a typical 5-7 minute deep scan; well
// under the rate-limit ceiling and matches /la-list enrich.
const PROGRESS_EDIT_THROTTLE_MS = 30 * 1000;

/**
 * Build the onProgress callback used by both the hidden-roster and the
 * visible-roster deep-scan paths. Wraps Discord editReply with a 30s
 * throttle and skips the final 100% tick because the post-scan branch
 * overwrites the embed immediately afterwards (would flicker for ms).
 */
function makeRosterScanProgressCallback({ interaction, name, meta, totalMembers, startedAtRef, lastEditRef }) {
  return (progress) => {
    const now = Date.now();
    const isFinal = progress.scannedCandidates >= progress.totalCandidates;
    if (!isFinal && now - lastEditRef.value < PROGRESS_EDIT_THROTTLE_MS) {
      return;
    }
    lastEditRef.value = now;
    if (isFinal) return;
    interaction.editReply({
      content: '',
      embeds: [buildScanProgressEmbed({
        title: `Stronghold scan in progress · ${name}`,
        subtitle: `Guild **${meta.guildName}**` +
          (totalMembers ? ` (${totalMembers} members)` : ''),
        color: COLORS.info,
        progress: { ...progress, totalMembers, startedAt: startedAtRef.value },
      })],
    }).catch((err) => {
      console.warn('[roster] Progress edit failed:', err?.message || err);
    });
  };
}

function formatDeepScanStats(altResult) {
  if (!altResult) return '';

  const parts = [`scanned ${altResult.scannedCandidates ?? 0}`];
  if ((altResult.skippedCandidates ?? 0) > 0) {
    parts.push(`skipped ${altResult.skippedCandidates} by limit`);
  }
  if ((altResult.failedCandidates ?? 0) > 0) {
    parts.push(`failed ${altResult.failedCandidates}`);
  }
  if (altResult.concurrency) {
    parts.push(`concurrency ${altResult.concurrency}`);
  }
  parts.push(`ScraperAPI ${altResult.usedScraperApiForCandidates ? 'on' : 'off'}`);
  return parts.join(' · ');
}

export async function handleRosterCommand(interaction) {
  const raw = interaction.options.getString('name');
  const name = normalizeCharacterName(raw);
  const deep = interaction.options.getBoolean('deep') ?? false;
  const deepLimit = interaction.options.getInteger('deep_limit');
  // ScraperAPI is intentionally locked off for the per-candidate scan
  // because that is the high-fanout (300+ requests) path that would burn
  // quota fast. Single-request meta + guild fetches inside the detector
  // (when targetMeta / guildMembers are NOT pre-supplied) still allow
  // ScraperAPI fallback - same rationale as the pre-flight probes below.
  const deepOptions = {
    ...(deepLimit !== null ? { candidateLimit: deepLimit } : {}),
    useScraperApiForCandidates: false,
  };
  await interaction.deferReply();

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await fetchWithFallback(targetUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = new JSDOM(html, { virtualConsole }).window;
    const characters = await parseRosterCharactersFromHtml(html, document);

    if (characters.length === 0) {
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
        // Step 1: Get guild member list (fast, single request — ScraperAPI eligible)
        const guildMembers = await fetchGuildMembers(name, {
          timeoutMs: config.strongholdDeepCandidateTimeoutMs,
          cacheKey: meta.guildName,
        });
        const memberNames = guildMembers.map((m) => m.name);

        // Step 2: Quick DB check — are any guild members already in the lists?
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
          // Send a 0% progress embed immediately so the officer knows the
          // scan started. onProgress edits this same message every 30s.
          const startedAtRef = { value: Date.now() };
          const lastEditRef = { value: startedAtRef.value };
          const filteredCount = guildMembers.filter((m) => m.name !== name && m.ilvl >= 1700).length;
          const cap = deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit;
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
                currentBackoffMs: config.scanBackoffMinMs,
                totalMembers: guildMembers.length,
                startedAt: startedAtRef.value,
              },
            })],
          }).catch(() => {});

          altResult = await detectAltsViaStronghold(name, {
            ...deepOptions,
            targetMeta: meta,
            guildMembers,
            onProgress: makeRosterScanProgressCallback({
              interaction,
              name,
              meta,
              totalMembers: guildMembers.length,
              startedAtRef,
              lastEditRef,
            }),
          });
        }
        const alts = altResult?.alts ?? [];
        const deepStats = formatDeepScanStats(altResult);

        // Build response
        const descriptionParts = [];

        descriptionParts.push(
          `Roster is hidden. Guild: **${meta.guildName}** (${guildMembers.length} members)`,
          `Stronghold: **${meta.strongholdName}** Lv.${meta.strongholdLevel} · Roster Lv.${meta.rosterLevel}`,
        );

        if (alts.length > 0) {
          descriptionParts.push(
            '',
            `**Same-account alts (${alts.length}):**`,
            ...alts.map(
              (a, i) => `${i + 1}. [${a.name}](https://lostark.bible/character/NA/${encodeURIComponent(a.name)}/roster) · ${a.className || '?'} · \`${a.itemLevel}\``
            ),
          );
        } else if (!deep) {
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
              (e) => `⛔ **${e.name}** — ${e.reason || 'no reason'}${e.raid ? ' [' + e.raid + ']' : ''}`
            ),
          );
        }

        if (guildWhiteHits.length > 0) {
          descriptionParts.push(
            '',
            `**✅ Whitelisted guild members (${guildWhiteHits.length}):**`,
            ...guildWhiteHits.map(
              (e) => `✅ **${e.name}** — ${e.reason || 'no reason'}${e.raid ? ' [' + e.raid + ']' : ''}`
            ),
          );
        }

        const description = descriptionParts.join('\n');
        const hasBlack = guildBlackHits.length > 0;
        const hasWhite = guildWhiteHits.length > 0;
        const color = hasBlack ? COLORS.danger : hasWhite ? COLORS.success : COLORS.warning;

        const embed = new EmbedBuilder()
          .setTitle(`Hidden Roster – ${name}`)
          .setURL(`https://lostark.bible/character/NA/${encodeURIComponent(name)}`)
          .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
          .setColor(color)
          .setFooter({ text: `${deep ? `${alts.length} alt(s) · ` : ''}${guildMembers.length} guild members${deepStats ? ` · ${deepStats}` : ''} · lostark.bible` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // No guild — show suggestions as before
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

    // Load previous snapshots for progression delta
    await connectDB();
    const prevSnapshots = new Map();
    const existingSnaps = await RosterSnapshot.find({
      name: { $in: characters.map((c) => c.name) },
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    for (const snap of existingSnaps) {
      prevSnapshots.set(snap.name.toLowerCase(), snap);
    }

    const lines = characters.map((c, i) => {
      const prevSnap = prevSnapshots.get(c.name.toLowerCase());
      const currentIlvl = parseFloat((c.itemLevel ?? '0').replace(/,/g, ''));
      let delta = '';
      if (prevSnap && prevSnap.itemLevel > 0) {
        const diff = currentIlvl - prevSnap.itemLevel;
        if (diff > 0) delta = ` *(+${diff.toFixed(2)})*`;
        else if (diff < 0) delta = ` *(${diff.toFixed(2)})*`;
      }

      return `**${i + 1}.** ${c.name} · ${c.className || 'Unknown'} · \`${c.itemLevel}\`${delta} · ${c.combatScore}`;
    });

    let description = lines.join('\n');
    if (description.length > 4000) {
      description = description.slice(0, 4000) + '\n…';
    }

    // Save/update snapshots in background
    (async () => {
      for (const c of characters) {
        const ilvl = parseFloat((c.itemLevel ?? '0').replace(/,/g, ''));
        await RosterSnapshot.updateOne(
          { name: c.name },
          {
            $set: {
              itemLevel: ilvl,
              classId: c.classId || '',
              combatScore: c.combatScore || '',
              rosterName: name,
              updatedAt: new Date(),
            },
          },
          { upsert: true, collation: { locale: 'en', strength: 2 } }
        );
      }
    })().catch((err) => console.warn('[roster] Snapshot save failed:', err.message));

    const charNames = characters
      .filter((c) => parseFloat((c.itemLevel ?? '0').replace(/,/g, '')) >= 1700)
      .map((c) => c.name);

    const [blacklistResult, whitelistResult, trustedResult] = await Promise.all([
      handleRosterBlackListCheck(charNames, { guildId: interaction.guild?.id }),
      handleRosterWhiteListCheck(charNames),
      TrustedUser.findOne({ name: { $in: charNames } }).collation({ locale: 'en', strength: 2 }).lean(),
    ]);

    const embedColor = blacklistResult ? COLORS.danger : whitelistResult ? COLORS.success : trustedResult ? COLORS.trustedSoft : COLORS.info;
    const embed = new EmbedBuilder()
      .setTitle(`Roster – ${name}`)
      .setURL(targetUrl)
      .setDescription(description)
      .setColor(embedColor)
      .setFooter({ text: `${characters.length} character(s) · lostark.bible` })
      .setTimestamp();

    const embeds = [embed];
    const contentLines = [];

    if (trustedResult) {
      contentLines.push(`🛡️ **${trustedResult.name}** is a trusted user.${trustedResult.reason ? ` — *${trustedResult.reason}*` : ''}`);
    }

    if (blacklistResult) {
      const reason = blacklistResult.reason ? ` — *${blacklistResult.reason}*` : '';
      const raid = blacklistResult.raid ? ` [${blacklistResult.raid}]` : '';
      contentLines.push(`⛔ **${name}** is on the blacklist.${raid}${reason}`);

      // Resolve fresh URL for rehosted entries; legacy entries use stored URL.
      const blackImageUrl = await resolveDisplayImageUrl(blacklistResult, interaction.client);
      if (blackImageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Blacklist Evidence')
          .setImage(blackImageUrl)
          .setColor(COLORS.danger);
        embeds.unshift(evidenceEmbed);
      }
    }

    if (whitelistResult) {
      const reason = whitelistResult.reason ? ` — *${whitelistResult.reason}*` : '';
      const raid = whitelistResult.raid ? ` [${whitelistResult.raid}]` : '';
      contentLines.push(`✅ **${name}** is on the whitelist.${raid}${reason}`);

      const whiteImageUrl = await resolveDisplayImageUrl(whitelistResult, interaction.client);
      if (whiteImageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Whitelist Evidence')
          .setImage(whiteImageUrl)
          .setColor(COLORS.success);
        embeds.unshift(evidenceEmbed);
      }
    }

    // Deep scan: Stronghold alt detection even when roster is visible
    if (deep) {
      try {
        // Pre-fetch meta + guild members so we can render an initial
        // progress embed with guild context (member count, name) before
        // the candidate fan-out starts. The detector skips its own
        // internal target/guild fetches when both are pre-supplied.
        const visMeta = await fetchCharacterMeta(name, {
          timeoutMs: config.strongholdDeepCandidateTimeoutMs,
        });
        const visGuildMembers = visMeta?.guildName
          ? await fetchGuildMembers(name, {
              timeoutMs: config.strongholdDeepCandidateTimeoutMs,
              cacheKey: visMeta.guildName,
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
        if (visMeta?.guildName && visGuildMembers.length > 0) {
          await interaction.editReply({
            content: '',
            embeds: [buildScanProgressEmbed({
              title: `Stronghold scan in progress · ${name}`,
              subtitle: `Guild **${visMeta.guildName}** (${visGuildMembers.length} members) · visible roster`,
              color: COLORS.info,
              progress: {
                scannedCandidates: 0,
                totalCandidates: Math.min(visFilteredCount, visCap || visFilteredCount),
                altsFound: 0,
                failedCandidates: 0,
                currentBackoffMs: config.scanBackoffMinMs,
                totalMembers: visGuildMembers.length,
                startedAt: startedAtRef.value,
              },
            })],
          }).catch(() => {});
        }

        const altResult = await detectAltsViaStronghold(name, {
          ...deepOptions,
          ...(visMeta ? { targetMeta: visMeta } : {}),
          ...(visGuildMembers.length > 0 ? { guildMembers: visGuildMembers } : {}),
          onProgress: visMeta?.guildName && visGuildMembers.length > 0
            ? makeRosterScanProgressCallback({
                interaction,
                name,
                meta: visMeta,
                totalMembers: visGuildMembers.length,
                startedAtRef,
                lastEditRef,
              })
            : undefined,
        });
        const deepStats = formatDeepScanStats(altResult);
        if (altResult && altResult.alts.length > 0) {
          const altLines = altResult.alts.map(
            (a, i) => `${i + 1}. [${a.name}](https://lostark.bible/character/NA/${encodeURIComponent(a.name)}/roster) · ${a.className || '?'} · \`${a.itemLevel}\``
          );
          embed.addFields({
            name: `🔎 Deep Scan — Alts via Stronghold (${altResult.alts.length})`,
            value: [...altLines, deepStats ? `\n${deepStats}` : null].filter(Boolean).join('\n').slice(0, 1024),
            inline: false,
          });
        } else {
          embed.addFields({
            name: '🔎 Deep Scan',
            value: `No additional alts found via Stronghold fingerprint.${deepStats ? `\n${deepStats}` : ''}`,
            inline: false,
          });
        }
      } catch (err) {
        embed.addFields({
          name: '🔎 Deep Scan',
          value: `Failed: ${err.message}`,
          inline: false,
        });
      }
    }

    const content = contentLines.length > 0 ? contentLines.join('\n') : undefined;

    await interaction.editReply({ content, embeds });
  } catch (err) {
    await interaction.editReply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Roster Fetch Failed',
        description: 'Could not fetch the roster from lostark.bible.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      })],
    });
  }
}
