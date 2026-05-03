/**
 * statsHandler.js
 * Handles /la-stats command — shows bot usage statistics.
 */

import { EmbedBuilder } from 'discord.js';
import { connectDB } from '../db.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import Watchlist from '../models/Watchlist.js';
import RosterCache from '../models/RosterCache.js';
import GuildConfig from '../models/GuildConfig.js';

export async function handleStatsCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });
  await connectDB();

  const [blackCount, whiteCount, watchCount, cacheCount, guildConfigCount] = await Promise.all([
    Blacklist.countDocuments(),
    Whitelist.countDocuments(),
    Watchlist.countDocuments(),
    RosterCache.countDocuments(),
    GuildConfig.countDocuments(),
  ]);

  const totalList = blackCount + whiteCount + watchCount;

  // Bot uptime
  const uptimeMs = interaction.client.uptime || 0;
  const hours = Math.floor(uptimeMs / 3600000);
  const minutes = Math.floor((uptimeMs % 3600000) / 60000);

  // Guild count
  const guildCount = interaction.client.guilds.cache.size;

  const embed = new EmbedBuilder()
    .setTitle('📊 Bot Statistics')
    .addFields(
      { name: '📋 Lists', value: `⛔ Blacklist: **${blackCount}**\n✅ Whitelist: **${whiteCount}**\n⚠️ Watchlist: **${watchCount}**\nTotal: **${totalList}**`, inline: true },
      { name: '💾 Cache', value: `Roster Cache: **${cacheCount}** entries\nGuild Configs: **${guildConfigCount}**`, inline: true },
      { name: '🤖 Bot', value: `Servers: **${guildCount}**\nUptime: **${hours}h ${minutes}m**`, inline: true },
    )
    .setColor(0x5865f2)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
