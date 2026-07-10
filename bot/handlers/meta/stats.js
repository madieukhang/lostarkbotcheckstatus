/**
 * handlers/meta/stats.js
 * /la-stats command · shows bot usage statistics. Counts are
 * Promise.all-batched for one round-trip; the 7-day "growth pulse"
 * uses a $gte timestamp filter so a missing index would still work
 * (just slower). Embed is ephemeral · stats are for operators not
 * channel chat.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';
import { connectDB } from '../../db.js';
import { COLORS, ICONS, relativeTime } from '../../utils/ui.js';
import { deferEphemeralReply, editEmbed } from '../../utils/interactionReplies.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import RosterCache from '../../models/RosterCache.js';
import GuildConfig from '../../models/GuildConfig.js';
import UserPreference from '../../models/UserPreference.js';
import { getScraperApiUsageSnapshot } from '../../utils/scraperApiUsage.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';

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
  const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });

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
    .map((key) => t('dialogue.stats.keyLine', lang, {
      key: key.keyNumber,
      requests: key.totalRequests,
      ok: key.successResponses,
      failed: key.failedResponses,
    }))
    .join('\n');

  // Same card anatomy as the /la-list add result: icon title + one-line
  // hero description; the refresh hint lives in the footer tip instead
  // of eating a second description line.
  const embed = createArtistEmbed(lang)
    .setTitle(`📊 ${t('dialogue.stats.title', lang)}`)
    .setDescription(t('dialogue.stats.description', lang))
    .addFields(
      {
        name: `${ICONS.shield} ${t('dialogue.stats.listsField', lang)}`,
        value: [
          `⛔ ${t('dialogue.stats.blacklistLine', lang, { count: blackCount })}`,
          `✅ ${t('dialogue.stats.whitelistLine', lang, { count: whiteCount })}`,
          `⚠️ ${t('dialogue.stats.watchlistLine', lang, { count: watchCount })}`,
          t('dialogue.stats.totalLine', lang, { count: totalList }),
        ].join('\n'),
        inline: true,
      },
      {
        name: `${ICONS.refresh} ${t('dialogue.stats.cacheField', lang)}`,
        value: [
          t('dialogue.stats.rosterCacheLine', lang, { count: cacheCount }),
          t('dialogue.stats.guildConfigsLine', lang, { count: guildConfigCount }),
        ].join('\n'),
        inline: true,
      },
      {
        name: `${ICONS.info} ${t('dialogue.stats.botField', lang)}`,
        value: [
          t('dialogue.stats.serversLine', lang, { count: guildCount }),
          t('dialogue.stats.uptimeLine', lang, { uptime: formatUptime(uptimeMs) }),
          startedAt ? t('dialogue.stats.startedLine', lang, { time: relativeTime(startedAt) }) : null,
        ].filter(Boolean).join('\n'),
        inline: true,
      },
      {
        name: `${ICONS.search} ${t('dialogue.stats.activityField', lang)}`,
        value: t('dialogue.stats.recentBlacklist', lang, {
          count: recentBlackCount,
          entryWord: t(recentBlackCount === 1 ? 'dialogue.stats.entryOne' : 'dialogue.stats.entryMany', lang),
        }),
        inline: true,
      },
      {
        name: `${ICONS.refresh} ${t('dialogue.stats.scraperField', lang)}`,
        value: scraperApiHasActivity
          ? [
              t('dialogue.stats.scraperSummary', lang, {
                requests: scraperApiUsage.totalRequests,
                ok: scraperApiUsage.successResponses,
                failed: scraperApiUsage.failedResponses,
                networkTail: scraperApiUsage.networkErrors > 0
                  ? t('dialogue.stats.networkTail', lang, { count: scraperApiUsage.networkErrors })
                  : '',
              }),
              scraperApiUsage.lastRequestAt
                ? t('dialogue.stats.lastUsed', lang, { time: relativeTime(scraperApiUsage.lastRequestAt) })
                : null,
              scraperKeyLines || null,
            ].filter(Boolean).join('\n').slice(0, 1024)
          : t('dialogue.stats.scraperIdle', lang),
        inline: true,
      },
    )
    .setColor(COLORS.info)
    .setFooter({ text: t('dialogue.stats.footer', lang) })
    .setTimestamp();

  await editEmbed(interaction, embed);
}
