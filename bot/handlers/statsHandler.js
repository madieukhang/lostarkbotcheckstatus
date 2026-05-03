/**
 * statsHandler.js
 * Handles /la-stats command · shows bot usage statistics.
 */

import { EmbedBuilder } from 'discord.js';
import { connectDB } from '../db.js';
import { COLORS, ICONS, relativeTime } from '../utils/ui.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import Watchlist from '../models/Watchlist.js';
import RosterCache from '../models/RosterCache.js';
import GuildConfig from '../models/GuildConfig.js';
import { getScraperApiUsageSnapshot } from '../utils/scraperApiUsage.js';

function formatUptime(ms) {
  if (!ms || ms < 0) return '0m';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export async function handleStatsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  const [blackCount, whiteCount, watchCount, cacheCount, guildConfigCount, recentBlackCount] = await Promise.all([
    Blacklist.countDocuments(),
    Whitelist.countDocuments(),
    Watchlist.countDocuments(),
    RosterCache.countDocuments(),
    GuildConfig.countDocuments(),
    // Last-7-days addition rate gives a "list growth" pulse without
    // needing a full time-series chart.
    Blacklist.countDocuments({
      addedAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    }),
  ]);

  const totalList = blackCount + whiteCount + watchCount;
  const uptimeMs = interaction.client.uptime || 0;
  const startedAt = uptimeMs > 0 ? Date.now() - uptimeMs : null;
  const guildCount = interaction.client.guilds.cache.size;
  const scraperApiUsage = getScraperApiUsageSnapshot();
  const scraperKeyLines = scraperApiUsage.keyCounts.length > 0
    ? scraperApiUsage.keyCounts
        .map((key) => `Key #${key.keyNumber}: **${key.totalRequests}** (${key.successResponses} ok / ${key.failedResponses} fail)`)
        .join('\n')
    : 'No ScraperAPI requests this process.';

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Lost Ark Check · Bot Statistics' })
    .setDescription(
      `Live snapshot of the bot's persistence + cache state.\n` +
      `Refresh by re-running \`/la-stats\`.`,
    )
    .addFields(
      {
        name: `${ICONS.shield} Lists`,
        value: [
          `⛔ Blacklist: **${blackCount}**`,
          `✅ Whitelist: **${whiteCount}**`,
          `⚠️ Watchlist: **${watchCount}**`,
          `**Total:** ${totalList}`,
        ].join('\n'),
        inline: true,
      },
      {
        name: `${ICONS.refresh} Cache`,
        value: [
          `Roster Cache: **${cacheCount}**`,
          `Guild Configs: **${guildConfigCount}**`,
        ].join('\n'),
        inline: true,
      },
      {
        name: `${ICONS.info} Bot`,
        value: [
          `Servers: **${guildCount}**`,
          `Uptime: **${formatUptime(uptimeMs)}**`,
          startedAt ? `Started ${relativeTime(startedAt)}` : null,
        ].filter(Boolean).join('\n'),
        inline: true,
      },
      {
        name: '​',
        value: '​',
        inline: false,
      },
      {
        name: `${ICONS.search} Activity (last 7 days)`,
        value: `**${recentBlackCount}** new blacklist entr${recentBlackCount === 1 ? 'y' : 'ies'}`,
        inline: false,
      },
      {
        name: `${ICONS.refresh} ScraperAPI Usage (process)`,
        value: [
          `Requests: **${scraperApiUsage.totalRequests}**`,
          `Success: **${scraperApiUsage.successResponses}**`,
          `Failed: **${scraperApiUsage.failedResponses}**`,
          scraperApiUsage.networkErrors > 0 ? `Network errors: **${scraperApiUsage.networkErrors}**` : null,
          scraperApiUsage.lastRequestAt ? `Last used ${relativeTime(scraperApiUsage.lastRequestAt)}` : null,
          '',
          scraperKeyLines,
        ].filter((line) => line !== null).join('\n').slice(0, 1024),
        inline: false,
      },
    )
    .setColor(COLORS.info)
    .setFooter({ text: 'Officer-only command · ephemeral reply' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
