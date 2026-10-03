/**
 * handlers/meta/stats.js
 * /la-stats command · shows bot usage statistics. Counts are
 * Promise.all-batched for one round-trip; the seven-day growth metric
 * uses a $gte timestamp filter so a missing index would still work
 * (just slower). Embed is ephemeral · stats are for operators not
 * channel chat.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';
import config from '../../config.js';
import { connectDB } from '../../db.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { COLORS, ICONS, padInlineRow, relativeTime } from '../../utils/ui.js';
import { deferEphemeralReply, editAlert, editEmbed } from '../../utils/interactionReplies.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import GuildConfig from '../../models/GuildConfig.js';
import UserPreference from '../../models/UserPreference.js';
import { getScraperApiUsageSnapshot } from '../../utils/scraperApiUsage.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';

function formatUptime(ms) {
  if (!ms || ms < 0) return '0m';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return [
    days > 0 ? `${days}d` : '',
    hours > 0 ? `${hours}h` : '',
    `${minutes}m`,
  ].filter(Boolean).join(' ');
}

/**
 * Handle `/la-stats`. Defers ephemerally (DB roll-up takes a few hundred
 * ms even on fresh indexes) then edits with the rolled-up embed.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleStatsCommand(interaction, { connectDBFn = connectDB } = {}) {
  await deferEphemeralReply(interaction);
  await connectDBFn();
  const lang = await getUserLanguage(interaction.user?.id, { UserPreferenceModel: UserPreference });

  // /la-stats exposes operator-facing numbers (ScraperAPI usage, guild
  // counts), so it is senior-only by handler check · owner-guild
  // registration alone is not a permission.
  if (!config.seniorApproverIds.includes(interaction.user?.id)) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.system.seniorOnly', lang),
      lang,
    });
    return;
  }

  const [blackCount, whiteCount, watchCount, guildConfigCount, recentBlackCount] = await Promise.all([
    Blacklist.countDocuments(),
    Whitelist.countDocuments(),
    Watchlist.countDocuments(),
    GuildConfig.countDocuments(),
    // Last-seven-days addition rate provides a list-growth metric without
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
  const embed = createArtistEmbed()
    .setTitle(`📊 ${t('dialogue.stats.title', lang)}`)
    .setDescription(t('dialogue.stats.description', lang))
    // Five inline panels · padded to six so the second row keeps the
    // same three columns as the first instead of splitting in half.
    .addFields(...padInlineRow([
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
        value: t('dialogue.stats.guildConfigsLine', lang, { count: guildConfigCount }),
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
    ]))
    .setColor(COLORS.info)
    .setFooter({ text: t('dialogue.stats.footer', lang) })
    .setTimestamp();

  await editEmbed(interaction, embed);
}
