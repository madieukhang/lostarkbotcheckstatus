import { EmbedBuilder } from 'discord.js';

import { connectDB } from '../../db.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { getClassName } from '../../models/Class.js';
import { fetchNameSuggestions } from '../services/rosterService.js';
import { normalizeCharacterName } from '../utils/names.js';

export async function handleSearchCommand(interaction) {
  const raw = interaction.options.getString('name', true);
  const name = normalizeCharacterName(raw);
  const minIlvl = interaction.options.getInteger('min_ilvl') ?? 1700;
  const maxIlvl = interaction.options.getInteger('max_ilvl') ?? null;
  const classFilter = interaction.options.getString('class') ?? null;

  await interaction.deferReply();

  try {
    let suggestions = await fetchNameSuggestions(name);

    if (suggestions.length === 0) {
      await interaction.editReply({
        content: `❌ No results found for **${name}**.`,
      });
      return;
    }

    // Apply filters
    suggestions = suggestions.filter((s) => {
      const ilvl = Number(s.itemLevel || 0);
      if (ilvl < minIlvl) return false;
      if (maxIlvl !== null && ilvl > maxIlvl) return false;
      if (classFilter && s.cls !== classFilter) return false;
      return true;
    });

    if (suggestions.length === 0) {
      const filterDesc = [];
      filterDesc.push(`ilvl ≥ ${minIlvl}`);
      if (maxIlvl !== null) filterDesc.push(`ilvl ≤ ${maxIlvl}`);
      if (classFilter) filterDesc.push(`class: ${getClassName(classFilter)}`);

      await interaction.editReply({
        content: `❌ No results for **${name}** with filters: ${filterDesc.join(', ')}`,
      });
      return;
    }

    // Cross-check against all lists
    await connectDB();

    const results = await Promise.all(
      suggestions.slice(0, 15).map(async (s) => {
        const [black, white, watch] = await Promise.all([
          Blacklist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
          Whitelist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
          Watchlist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 })
            .lean(),
        ]);

        return { ...s, black, white, watch };
      })
    );

    const lines = results.map((r, i) => {
      const cls = getClassName(r.cls);
      const ilvl = Number(r.itemLevel || 0).toFixed(2);

      let icon = '';
      if (r.black) icon += '⛔';
      if (r.white) icon += '✅';
      if (r.watch) icon += '⚠️';
      if (icon) icon += ' ';

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
      if (r.watch) {
        line += `\n    ↳ watch: *${r.watch.reason || 'no reason'}*`;
        if (r.watch.raid) line += ` [${r.watch.raid}]`;
      }

      return line;
    });

    const description = lines.join('\n');

    const hasBlack = results.some((r) => r.black);
    const hasWatch = results.some((r) => r.watch);
    const hasWhite = results.some((r) => r.white);
    const color = hasBlack ? 0xed4245 : hasWatch ? 0xfee75c : hasWhite ? 0x57f287 : 0x5865f2;

    // Build footer with active filters
    const filterParts = [`ilvl ≥ ${minIlvl}`];
    if (maxIlvl !== null) filterParts.push(`ilvl ≤ ${maxIlvl}`);
    if (classFilter) filterParts.push(getClassName(classFilter));

    const embed = new EmbedBuilder()
      .setTitle(`Search: "${name}"`)
      .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
      .setColor(color)
      .setFooter({ text: `${results.length} result(s) · ${filterParts.join(' · ')} · lostark.bible` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[search] ❌ Search failed:', err.message);
    await interaction.editReply({
      content: `⚠️ Search failed: \`${err.message}\``,
    });
  }
}
