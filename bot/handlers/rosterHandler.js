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
  // ScraperAPI is intentionally locked off for /roster deep candidate
  // scans: team policy (per Dusk's review) is to never burn ScraperAPI
  // quota on the per-candidate fetch fan-out, since it can blow through
  // the daily cap on a single large guild like Bullet Shell. The user-
  // facing `deep_scraperapi` slash option was removed for the same
  // reason. The env override `STRONGHOLD_DEEP_USE_SCRAPERAPI` still
  // exists in config.js as an emergency ops escape hatch but defaults
  // to false and should stay false in production.
  const deepOptions = {
    ...(deepLimit !== null ? { candidateLimit: deepLimit } : {}),
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
      const meta = await fetchCharacterMeta(name);
      const hasGuild = meta && meta.guildName;

      if (hasGuild) {
        // Step 1: Get guild member list (fast, single request)
        const guildMembers = await fetchGuildMembers(name);
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

        // Step 3: Stronghold fingerprint scan for same-account alts
        const altResult = await detectAltsViaStronghold(name, deepOptions);
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
        const color = hasBlack ? 0xed4245 : hasWhite ? 0x57f287 : 0xfee75c;

        const embed = new EmbedBuilder()
          .setTitle(`Hidden Roster – ${name}`)
          .setURL(`https://lostark.bible/character/NA/${encodeURIComponent(name)}`)
          .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
          .setColor(color)
          .setFooter({ text: `${alts.length} alt(s) · ${guildMembers.length} guild members${deepStats ? ` · ${deepStats}` : ''} · lostark.bible` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // No guild — show suggestions as before
      const suggestions = await fetchNameSuggestions(name) || [];
      const filtered = suggestions.filter((s) => s.itemLevel > 1700);
      if (filtered.length > 0) {
        const embed = new EmbedBuilder()
          .setDescription(formatSuggestionLines(filtered))
          .setColor(0xed4245)
          .setTimestamp();
        await interaction.editReply({
          content: `❌ No roster found for **${name}**. Rosters similar to **${name}**:`,
          embeds: [embed],
        });
      } else {
        await interaction.editReply({
          content: `❌ No roster found for **${name}**. Check the name and try again.`,
        });
      }
      return;
    }

    // Fetch titles via direct access (no ScraperAPI needed)
    await Promise.all(
      characters.slice(0, 10).map(async (c) => {
        try {
          const charUrl = `https://lostark.bible/character/NA/${encodeURIComponent(c.name)}`;
          const res = await fetchWithFallback(charUrl);
          if (!res.ok) return;
          const charHtml = await res.text();
          const titleMatch = charHtml.match(/<span[^>]*style[^>]*color[^>]*>([^<]+)<\/span>/);
          c.title = titleMatch?.[1]?.trim() ?? null;
        } catch {
          c.title = null;
        }
      })
    );

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

      return `**${i + 1}.** ${c.name} · ${c.className || 'Unknown'} · \`${c.itemLevel}\`${delta}${c.title ? ` — *${c.title}*` : ''} · ${c.combatScore}`;
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

    const embedColor = blacklistResult ? 0xed4245 : whitelistResult ? 0x57f287 : trustedResult ? 0x57d6a1 : 0x5865f2;
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
          .setColor(0xed4245);
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
          .setColor(0x57f287);
        embeds.unshift(evidenceEmbed);
      }
    }

    // Deep scan: Stronghold alt detection even when roster is visible
    if (deep) {
      try {
        const altResult = await detectAltsViaStronghold(name, deepOptions);
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
      content: `⚠️ Failed to fetch roster: \`${err.message}\``,
    });
  }
}
