import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';

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
      await interaction.editReply({ content: `❌ No results found for **${name}**.` });
      return;
    }

    suggestions = suggestions.filter((s) => {
      const ilvl = Number(s.itemLevel || 0);
      if (ilvl < minIlvl) return false;
      if (maxIlvl !== null && ilvl > maxIlvl) return false;
      if (classFilter && s.cls !== classFilter) return false;
      return true;
    });

    if (suggestions.length === 0) {
      const filterDesc = [`ilvl ≥ ${minIlvl}`];
      if (maxIlvl !== null) filterDesc.push(`ilvl ≤ ${maxIlvl}`);
      if (classFilter) filterDesc.push(`class: ${getClassName(classFilter)}`);
      await interaction.editReply({ content: `❌ No results for **${name}** with filters: ${filterDesc.join(', ')}` });
      return;
    }

    await connectDB();

    const results = await Promise.all(
      suggestions.slice(0, 15).map(async (s) => {
        const [black, white, watch] = await Promise.all([
          Blacklist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 }).lean(),
          Whitelist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 }).lean(),
          Watchlist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
            .collation({ locale: 'en', strength: 2 }).lean(),
        ]);
        return { ...s, black, white, watch };
      })
    );

    const lines = results.map((r, i) => {
      const cls = getClassName(r.cls);
      const ilvl = Number(r.itemLevel || 0).toFixed(2);
      const entry = r.black || r.white || r.watch;
      const hasImage = entry?.imageUrl;

      let icon = '';
      if (r.black) icon += '⛔';
      if (r.white) icon += '✅';
      if (r.watch) icon += '⚠️';
      if (icon) icon += ' ';

      const link = `[${r.name}](https://lostark.bible/character/NA/${encodeURIComponent(r.name)}/roster)`;
      let line = `**${i + 1}.** ${icon}${link} — ${cls || '?'} · \`${ilvl}\`${hasImage ? ' — 📎' : ''}`;

      if (r.black) {
        line += `\n    ↳ *${r.black.reason || 'no reason'}*`;
        if (r.black.raid) line += ` [${r.black.raid}]`;
      }
      if (r.white) {
        line += `\n    ↳ *${r.white.reason || 'no reason'}*`;
        if (r.white.raid) line += ` [${r.white.raid}]`;
      }
      if (r.watch) {
        line += `\n    ↳ *${r.watch.reason || 'no reason'}*`;
        if (r.watch.raid) line += ` [${r.watch.raid}]`;
      }

      return line;
    });

    const description = lines.join('\n');
    const hasBlack = results.some((r) => r.black);
    const hasWatch = results.some((r) => r.watch);
    const hasWhite = results.some((r) => r.white);
    const color = hasBlack ? 0xed4245 : hasWatch ? 0xfee75c : hasWhite ? 0x57f287 : 0x5865f2;

    const filterParts = [`ilvl ≥ ${minIlvl}`];
    if (maxIlvl !== null) filterParts.push(`ilvl ≤ ${maxIlvl}`);
    if (classFilter) filterParts.push(getClassName(classFilter));

    const embed = new EmbedBuilder()
      .setTitle(`Search: "${name}"`)
      .setDescription(description.length > 4000 ? description.slice(0, 4000) + '\n…' : description)
      .setColor(color)
      .setFooter({ text: `${results.length} result(s) · ${filterParts.join(' · ')} · lostark.bible` })
      .setTimestamp();

    // Build evidence dropdown for flagged entries with images
    const flaggedWithImages = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (r.black?.imageUrl || r.white?.imageUrl || r.watch?.imageUrl));

    const components = [];
    if (flaggedWithImages.length > 0) {
      components.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('search_evidence')
            .setPlaceholder('📎 View evidence for...')
            .addOptions(
              flaggedWithImages.slice(0, 25).map(({ r, i }) => {
                const entry = r.black || r.white || r.watch;
                let emoji = '⛔';
                if (r.white && !r.black) emoji = '✅';
                if (r.watch && !r.black && !r.white) emoji = '⚠️';
                return {
                  label: r.name,
                  description: (entry.reason || 'No reason').slice(0, 100),
                  value: String(i),
                  emoji,
                };
              })
            )
        )
      );
    }

    await interaction.editReply({ embeds: [embed], components });

    if (flaggedWithImages.length === 0) return;

    const reply = await interaction.fetchReply();
    const collector = reply.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 300000,
    });

    collector.on('collect', async (sel) => {
      if (sel.user.id !== interaction.user.id) {
        await sel.reply({ content: '⛔ Only the command user can view evidence.', ephemeral: true });
        return;
      }

      const idx = parseInt(sel.values[0]);
      const r = results[idx];
      const entry = r?.black || r?.white || r?.watch;

      if (!entry?.imageUrl) {
        await sel.reply({ content: 'No evidence image for this entry.', ephemeral: true });
        return;
      }

      const listLabel = r.black ? 'blacklist' : r.white ? 'whitelist' : 'watchlist';
      const listColor = r.black ? 0xed4245 : r.white ? 0x57f287 : 0xfee75c;

      const evidenceEmbed = new EmbedBuilder()
        .setTitle(`${r.black ? '⛔' : r.white ? '✅' : '⚠️'} ${r.name}`)
        .addFields(
          { name: 'Reason', value: entry.reason || 'N/A', inline: true },
          { name: 'Raid', value: entry.raid || 'N/A', inline: true },
          { name: 'List', value: listLabel, inline: true },
        )
        .setImage(entry.imageUrl)
        .setColor(listColor)
        .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

      if (entry.logsUrl) {
        evidenceEmbed.addFields({ name: 'Logs', value: `[View Logs](${entry.logsUrl})`, inline: false });
      }

      await sel.reply({ embeds: [evidenceEmbed], ephemeral: true });
    });

    collector.on('end', async () => {
      await interaction.editReply({ components: [] }).catch(() => {});
    });
  } catch (err) {
    console.error('[search] ❌ Search failed:', err.message);
    await interaction.editReply({ content: `⚠️ Search failed: \`${err.message}\`` });
  }
}
