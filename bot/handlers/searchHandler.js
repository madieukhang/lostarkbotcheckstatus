import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';

import { connectDB } from '../../db.js';
import { buildBlacklistQuery } from '../utils/scope.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
import { fetchNameSuggestions } from '../services/rosterService.js';
import { normalizeCharacterName } from '../utils/names.js';
import { resolveDisplayImageUrl } from '../utils/imageRehost.js';

/** Detect whether an entry has any image evidence (rehosted OR legacy). */
function entryHasImage(entry) {
  return Boolean(entry?.imageMessageId || entry?.imageUrl);
}

export async function handleSearchCommand(interaction) {
  const raw = interaction.options.getString('name', true);
  const name = normalizeCharacterName(raw);
  const minIlvl = interaction.options.getInteger('min_ilvl') ?? 1700;
  const maxIlvl = interaction.options.getInteger('max_ilvl') ?? null;
  const classFilter = interaction.options.getString('class') ?? null;

  await interaction.deferReply();

  try {
    let suggestions = await fetchNameSuggestions(name);

    if (suggestions === null) {
      await interaction.editReply({ content: `⚠️ lostark.bible is currently unavailable. Please try again later.` });
      return;
    }

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

    const searchGuildId = interaction.guild?.id || '';
    const sliced = suggestions.slice(0, 15);
    const allNames = sliced.map((s) => s.name);
    const collation = { locale: 'en', strength: 2 };
    const nameQuery = { $or: [{ name: { $in: allNames } }, { allCharacters: { $in: allNames } }] };
    const blackQuery = buildBlacklistQuery(nameQuery, searchGuildId);

    const [allBlack, allWhite, allWatch, allTrusted] = await Promise.all([
      Blacklist.find(blackQuery).collation(collation).lean(),
      Whitelist.find(nameQuery).collation(collation).lean(),
      Watchlist.find(nameQuery).collation(collation).lean(),
      TrustedUser.find({ name: { $in: allNames } }).collation(collation).lean(),
    ]);

    // Build O(1) lookup maps
    function buildEntryMap(entries) {
      const map = new Map();
      for (const e of entries) {
        map.set(e.name.toLowerCase(), e);
        for (const c of (e.allCharacters || [])) {
          const lower = c.toLowerCase();
          if (!map.has(lower) || e.scope === 'server') map.set(lower, e);
        }
      }
      return map;
    }
    allBlack.sort((a, b) => (a.scope === 'server' ? 1 : 0) - (b.scope === 'server' ? 1 : 0));
    const blackMap = buildEntryMap(allBlack);
    const whiteMap = buildEntryMap(allWhite);
    const watchMap = buildEntryMap(allWatch);
    const trustedMap = new Map(allTrusted.map((t) => [t.name.toLowerCase(), t]));

    const results = sliced.map((s) => ({
      ...s,
      black: blackMap.get(s.name.toLowerCase()) || null,
      white: whiteMap.get(s.name.toLowerCase()) || null,
      watch: watchMap.get(s.name.toLowerCase()) || null,
      trusted: trustedMap.get(s.name.toLowerCase()) || null,
    }));

    const lines = results.map((r, i) => {
      const cls = getClassName(r.cls);
      const ilvl = Number(r.itemLevel || 0).toFixed(2);
      const entry = r.black || r.white || r.watch;
      const hasImage = entryHasImage(entry);

      let icon = '';
      if (r.black) icon += '⛔';
      if (r.white) icon += '✅';
      if (r.watch) icon += '⚠️';
      if (r.trusted) icon += '🛡️';
      if (icon) icon += ' ';

      const link = `[${r.name}](https://lostark.bible/character/NA/${encodeURIComponent(r.name)}/roster)`;
      let line = `**${i + 1}.** ${icon}${link} — ${cls || '?'} · \`${ilvl}\`${hasImage ? ' — 📎' : ''}`;

      for (const [entry, label] of [[r.black, '⛔'], [r.white, '✅'], [r.watch, '⚠️']]) {
        if (!entry) continue;
        const isRosterMatch = entry.name.toLowerCase() !== r.name.toLowerCase();
        const via = isRosterMatch ? `via **${entry.name}** — ` : '';
        line += `\n    ↳ ${via}*${entry.reason || 'no reason'}*`;
        if (entry.raid) line += ` [${entry.raid}]`;
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

    // Build evidence dropdown for flagged entries with images (rehosted OR legacy)
    const flaggedWithImages = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => entryHasImage(r.black) || entryHasImage(r.white) || entryHasImage(r.watch));

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

      if (!entryHasImage(entry)) {
        await sel.reply({ content: 'No evidence image for this entry.', ephemeral: true });
        return;
      }

      // Resolve fresh URL: rehosted entries get a freshly-signed URL via the
      // evidence channel; legacy entries fall back to their stored URL (which
      // may already have expired).
      const displayUrl = await resolveDisplayImageUrl(entry, interaction.client);
      if (!displayUrl) {
        await sel.reply({ content: '⚠️ Image link expired or evidence message removed.', ephemeral: true });
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
        .setImage(displayUrl)
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
