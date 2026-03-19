import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import { getClassName } from '../../models/Class.js';
import { fetchNameSuggestions } from '../services/rosterService.js';
import { normalizeCharacterName } from '../utils/names.js';

export async function handleSearchCommand(interaction) {
  const raw = interaction.options.getString('name', true);
  const name = normalizeCharacterName(raw);

  await interaction.deferReply();

  try {
    const suggestions = await fetchNameSuggestions(name);

    if (suggestions.length === 0) {
      await interaction.editReply({
        content: `❌ No results found for **${name}**.`,
      });
      return;
    }

    // Cross-check each suggestion against blacklist/whitelist
    await connectDB();

    const results = await Promise.all(
      suggestions.slice(0, 15).map(async (s) => {
        const [black, white] = await Promise.all([
          Blacklist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
          Whitelist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
        ]);

        return { ...s, black, white };
      })
    );

    const lines = results.map((r, i) => {
      const cls = getClassName(r.cls);
      const ilvl = Number(r.itemLevel || 0).toFixed(2);

      let icon = '';
      if (r.black && r.white) icon = '⛔✅ ';
      else if (r.black) icon = '⛔ ';
      else if (r.white) icon = '✅ ';

      const link = `[${r.name}](https://lostark.bible/character/NA/${encodeURIComponent(r.name)}/roster)`;
      let line = `**${i + 1}.** ${icon}${link} — ${cls || '?'} · \`${ilvl}\``;

      if (r.black) {
        line += `\n    ↳ black: *${r.black.reason || 'no reason'}*`;
        if (r.black.raid) line += ` [${r.black.raid}]`;
      }
      if (r.white) {
        line += `\n    ↳ white: *${r.white.reason || 'no reason'}*`;
        if (r.white.raid) line += ` [${r.white.raid}]`;
      }

      return line;
    });

    const description = lines.join('\n');

    const hasBlack = results.some((r) => r.black);
    const hasWhite = results.some((r) => r.white);
    const color = hasBlack ? 0xed4245 : hasWhite ? 0x57f287 : 0x5865f2;

    const embed = new EmbedBuilder()
      .setTitle(`Search results for "${name}"`)
      .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
      .setColor(color)
      .setFooter({ text: `${results.length} result(s) · lostark.bible` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[search] ❌ Search failed:', err.message);
    await interaction.editReply({
      content: `⚠️ Search failed: \`${err.message}\``,
    });
  }
}
