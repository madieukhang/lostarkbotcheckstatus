/**
 * handlers/meta/stats.js
 * /la-stats command · shows bot usage statistics. Counts are
 * Promise.all-batched for one round-trip; the 7-day "growth pulse"
 * uses a $gte timestamp filter so a missing index would still work
 * (just slower). Embed is ephemeral · stats are for operators not
 * channel chat.
 */

import { EmbedBuilder } from 'discord.js';
import { connectDB } from '../../db.js';
import { COLORS, ICONS, relativeTime } from '../../utils/ui.js';
import { deferEphemeralReply, editEmbed } from '../../utils/interactionReplies.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import RosterCache from '../../models/RosterCache.js';
import GuildConfig from '../../models/GuildConfig.js';
import { getScraperApiUsageSnapshot } from '../../utils/scraperApiUsage.js';

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

/**
 * Handle `/la-stats`. Defers ephemerally (DB roll-up takes a few hundred
 * ms even on fresh indexes) then edits with the rolled-up embed.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleStatsCommand(interaction) {
  await deferEphemeralReply(interaction);
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
  const scraperApiHasActivity = scraperApiUsage.totalRequests > 0;
  const scraperKeyLines = scraperApiUsage.keyCounts
    .map((key) => `Key #${key.keyNumber}: **${key.totalRequests}** (${key.successResponses} ok / ${key.failedResponses} fail)`)
    .join('\n');

  // Same card anatomy as the /la-list add result: icon title + one-line
  // hero description; the refresh hint lives in the footer tip instead
  // of eating a second description line.
  const embed = new EmbedBuilder()
    .setTitle('📊 Bot Statistics')
    .setDescription(`Live snapshot of the bot's persistence + cache state.`)
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
        name: `${ICONS.search} Activity (last 7 days)`,
        value: `**${recentBlackCount}** new blacklist entr${recentBlackCount === 1 ? 'y' : 'ies'}`,
        inline: true,
      },
      {
        name: `${ICONS.refresh} ScraperAPI`,
        value: scraperApiHasActivity
          ? [
              `**${scraperApiUsage.totalRequests}** req · ${scraperApiUsage.successResponses} ok / ${scraperApiUsage.failedResponses} fail` +
                (scraperApiUsage.networkErrors > 0 ? ` / ${scraperApiUsage.networkErrors} net err` : ''),
              scraperApiUsage.lastRequestAt ? `Last used ${relativeTime(scraperApiUsage.lastRequestAt)}` : null,
              scraperKeyLines || null,
            ].filter(Boolean).join('\n').slice(0, 1024)
          : 'Idle this process.',
        inline: true,
      },
    )
    .setColor(COLORS.info)
    .setFooter({ text: 'Officer-only · ephemeral · re-run /la-stats to refresh' })
    .setTimestamp();

  await editEmbed(interaction, embed);
}
