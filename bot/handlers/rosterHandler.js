import { EmbedBuilder } from 'discord.js';
import { JSDOM } from 'jsdom';

import config from '../../config.js';
import {
  parseRosterCharactersFromHtml,
  fetchNameSuggestions,
  formatSuggestionLines,
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
} from '../services/rosterService.js';
import { getAddedByDisplay } from '../utils/names.js';

export async function handleRosterCommand(interaction) {
  const raw = interaction.options.getString('name');
  const name = raw.trim().charAt(0).toUpperCase() + raw.trim().slice(1).toLowerCase();
  await interaction.deferReply();

  try {
    const targetUrl = `https://lostark.bible/character/NA/${name}/roster`;
    const proxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(targetUrl)}`;
    const response = await fetch(proxyUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = new JSDOM(html).window;
    const characters = await parseRosterCharactersFromHtml(html, document);

    if (characters.length === 0) {
      const suggestions = await fetchNameSuggestions(name);
      const filtered = suggestions.filter((s) => s.itemLevel > 1680);
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

    await Promise.all(
      characters.slice(0, 10).map(async (c) => {
        try {
          const charProxyUrl = `https://api.scraperapi.com/?api_key=${config.scraperApiKey}&url=${encodeURIComponent(`https://lostark.bible/character/NA/${c.name}`)}`;
          const res = await fetch(charProxyUrl);
          if (!res.ok) return;
          const charHtml = await res.text();
          const { document: charDoc } = new JSDOM(charHtml).window;
          const h2 = charDoc.querySelector('h2.flex.items-center');
          const titleSpan = h2?.querySelector('span[style*="color"]');
          c.title = titleSpan?.textContent.trim() ?? null;
        } catch {
          c.title = null;
        }
      })
    );

    const lines = characters.map(
      (c, i) =>
        `**${i + 1}.** ${c.name} · ${c.className || 'Unknown'} · \`${c.itemLevel}\`${c.title ? ` — *${c.title}*` : ''} · ${c.combatScore}`
    );

    let description = lines.join('\n');
    if (description.length > 4000) {
      description = description.slice(0, 4000) + '\n…';
    }

    const charNames = characters
      .filter((c) => parseFloat((c.itemLevel ?? '0').replace(/,/g, '')) >= 1680)
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
      const addedBy = getAddedByDisplay(blacklistResult);
      const addedByText = addedBy ? ` — Added by: **${addedBy}**` : '';
      contentLines.push(`⛔ **${name}** is on the blacklist.${raid}${reason}${addedByText}`);

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
      const addedBy = getAddedByDisplay(whitelistResult);
      const addedByText = addedBy ? ` — Added by: **${addedBy}**` : '';
      contentLines.push(`✅ **${name}** is on the whitelist.${raid}${reason}${addedByText}`);

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
