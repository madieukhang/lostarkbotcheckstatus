import { EmbedBuilder } from 'discord.js';

import { getClassName } from '../../models/Class.js';
import { COLORS } from '../../utils/ui.js';
import { entryHasImage } from './evidence.js';

export function buildSearchResultEmbed({ name, results, minIlvl, maxIlvl, classFilter }) {
  const lines = results.map((result, index) => {
    const cls = getClassName(result.cls);
    const ilvl = Number(result.itemLevel || 0).toFixed(2);
    const entry = result.black || result.white || result.watch;
    const hasImage = entryHasImage(entry);

    let icon = '';
    if (result.black) icon += '⛔';
    if (result.white) icon += '✅';
    if (result.watch) icon += '⚠️';
    if (result.trusted) icon += '🛡️';
    if (icon) icon += ' ';

    const link = `[${result.name}](https://lostark.bible/character/NA/${encodeURIComponent(result.name)}/roster)`;
    let line = `**${index + 1}.** ${icon}${link} · ${cls || '?'} · \`${ilvl}\`${hasImage ? ' · 📎' : ''}`;

    for (const entry of [result.black, result.white, result.watch]) {
      if (!entry) continue;
      const isRosterMatch = entry.name.toLowerCase() !== result.name.toLowerCase();
      const via = isRosterMatch ? `via **${entry.name}** · ` : '';
      line += `\n    ↳ ${via}*${entry.reason || 'no reason'}*`;
      if (entry.raid) line += ` [${entry.raid}]`;
    }

    return line;
  });

  const blackCount = results.filter((result) => result.black).length;
  const watchCount = results.filter((result) => result.watch).length;
  const whiteCount = results.filter((result) => result.white).length;
  const trustedCount = results.filter((result) => result.trusted).length;
  const cleanCount = results.filter((result) =>
    !result.black && !result.watch && !result.white && !result.trusted
  ).length;
  const hasBlack = blackCount > 0;
  const hasWatch = watchCount > 0;
  const hasWhite = whiteCount > 0;
  const color = hasBlack ? COLORS.danger : hasWatch ? COLORS.warning : hasWhite ? COLORS.success : COLORS.info;

  const filterParts = [`ilvl ≥ ${minIlvl}`];
  if (maxIlvl !== null) filterParts.push(`ilvl ≤ ${maxIlvl}`);
  if (classFilter) filterParts.push(getClassName(classFilter));

  const breakdown = [];
  if (hasBlack) breakdown.push(`⛔ **${blackCount}**`);
  if (hasWatch) breakdown.push(`⚠️ **${watchCount}**`);
  if (hasWhite) breakdown.push(`✅ **${whiteCount}**`);
  if (trustedCount > 0) breakdown.push(`🛡️ **${trustedCount}**`);
  if (cleanCount > 0) breakdown.push(`❓ **${cleanCount}** clean`);
  const summaryLine = breakdown.length > 0
    ? `Found **${results.length}** match${results.length === 1 ? '' : 'es'}: ${breakdown.join(' · ')}`
    : `Found **${results.length}** match${results.length === 1 ? '' : 'es'}`;

  const description = `${summaryLine}\n\n${lines.join('\n')}`.slice(0, 4096);

  return new EmbedBuilder()
    .setTitle(`🔍 Search · "${name}"`)
    .setDescription(description)
    .setColor(color)
    .setFooter({
      text: `Filters: ${filterParts.join(' · ')} · Source: lostark.bible`,
    })
    .setTimestamp();
}
