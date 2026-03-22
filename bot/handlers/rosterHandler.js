import { EmbedBuilder } from 'discord.js';
import { JSDOM, VirtualConsole } from 'jsdom';

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => {});

import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
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
import { getClassName } from '../../models/Class.js';
import { getAddedByDisplay, normalizeCharacterName } from '../utils/names.js';

export async function handleRosterCommand(interaction) {
  const raw = interaction.options.getString('name');
  const name = normalizeCharacterName(raw);
  await interaction.deferReply();

  try {
    const targetUrl = `https://lostark.bible/character/NA/${name}/roster`;
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
        const [guildBlackHits, guildWhiteHits] = await Promise.all([
          Blacklist.find({
            $or: [
              { name: { $in: memberNames } },
              { allCharacters: { $in: memberNames } },
            ],
          })
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
        const altResult = await detectAltsViaStronghold(name);
        const alts = altResult?.alts ?? [];

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
          .setFooter({ text: `${alts.length} alt(s) · ${guildMembers.length} guild members · lostark.bible` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // No guild — show suggestions as before
      const suggestions = await fetchNameSuggestions(name);
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

    const [blacklistResult, whitelistResult] = await Promise.all([
      handleRosterBlackListCheck(charNames),
      handleRosterWhiteListCheck(charNames),
    ]);

    const embed = new EmbedBuilder()
      .setTitle(`Roster – ${name}`)
      .setURL(targetUrl)
      .setDescription(description)
      .setColor(blacklistResult ? 0xed4245 : whitelistResult ? 0x57f287 : 0x5865f2)
      .setFooter({ text: `${characters.length} character(s) · lostark.bible` })
      .setTimestamp();

    const embeds = [embed];
    const contentLines = [];

    if (blacklistResult) {
      const reason = blacklistResult.reason ? ` — *${blacklistResult.reason}*` : '';
      const raid = blacklistResult.raid ? ` [${blacklistResult.raid}]` : '';
      contentLines.push(`⛔ **${name}** is on the blacklist.${raid}${reason}`);

      if (blacklistResult.imageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Blacklist evidence')
          .setImage(blacklistResult.imageUrl)
          .setColor(0xed4245);
        embeds.unshift(evidenceEmbed);
      }
    }

    if (whitelistResult) {
      const reason = whitelistResult.reason ? ` — *${whitelistResult.reason}*` : '';
      const raid = whitelistResult.raid ? ` [${whitelistResult.raid}]` : '';
      contentLines.push(`✅ **${name}** is on the whitelist.${raid}${reason}`);

      if (whitelistResult.imageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Whitelist evidence')
          .setImage(whitelistResult.imageUrl)
          .setColor(0x57f287);
        embeds.unshift(evidenceEmbed);
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
