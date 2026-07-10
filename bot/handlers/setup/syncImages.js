import { AttachmentBuilder } from 'discord.js';
import { createArtistEmbed } from '../../utils/artistVoice.js';

import config from '../../config.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { editPayload } from '../../utils/interactionReplies.js';
import GuildConfig from '../../models/GuildConfig.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { rehostImage } from '../../utils/imageRehost.js';
import { t } from '../../services/i18n/index.js';

function isDiscordCdnUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.endsWith('discordapp.com') || u.hostname.endsWith('discordapp.net');
  } catch {
    return false;
  }
}

async function resolveDownloadUrl(entry, interaction, stats) {
  if (!isDiscordCdnUrl(entry.imageUrl)) {
    return entry.imageUrl;
  }

  const refreshResponse = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${interaction.client.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ attachment_urls: [entry.imageUrl] }),
  });

  if (!refreshResponse.ok) {
    stats.skippedDead += 1;
    stats.errors.push(`${entry.name}: refresh API returned ${refreshResponse.status}`);
    return null;
  }

  const refreshData = await refreshResponse.json();
  const refreshedUrl = refreshData?.refreshed_urls?.[0]?.refreshed;
  if (!refreshedUrl) {
    stats.skippedDead += 1;
    stats.errors.push(`${entry.name}: refresh returned no URL (file likely deleted)`);
    return null;
  }

  return refreshedUrl;
}

async function rehostWithRetry(downloadUrl, entry, type, interaction, stats) {
  let firstAttemptError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await rehostImage(downloadUrl, interaction.client, {
        entryName: entry.name,
        addedBy: `Migration by ${interaction.user.tag}`,
        listType: type,
        throwOnError: true,
      });
    } catch (err) {
      if (attempt === 1) {
        firstAttemptError = err.message;
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      const errMsg = err.message;
      const isDownloadFailure =
        errMsg.startsWith('download HTTP')
        || errMsg.startsWith('download fetch threw')
        || errMsg.startsWith('download read body');

      if (isDownloadFailure) {
        stats.skippedDead += 1;
        stats.errors.push(`${entry.name}: ${errMsg}`);
      } else {
        stats.failed += 1;
        stats.errors.push(`${entry.name}: ${errMsg}${firstAttemptError && firstAttemptError !== errMsg ? ` (attempt 1: ${firstAttemptError})` : ''}`);
      }

      return null;
    }
  }

  return null;
}

async function markEntryAsRehosted(model, entry, rehosted, stats) {
  const updateResult = await model.updateOne(
    {
      _id: entry._id,
      imageUrl: entry.imageUrl,
      $or: [
        { imageMessageId: '' },
        { imageMessageId: { $exists: false } },
      ],
    },
    {
      $set: {
        imageUrl: '',
        imageMessageId: rehosted.messageId,
        imageChannelId: rehosted.channelId,
      },
    }
  );

  if (updateResult.matchedCount === 1) {
    stats.synced += 1;
    return;
  }

  stats.skippedRaced += 1;
  stats.errors.push(`${entry.name}: entry changed during sync - orphan rehost left in channel`);
  console.warn(`[syncimages] Race detected for ${entry.name} - CAS update was no-op, orphan upload at ${rehosted.channelId}/${rehosted.messageId}`);
}

async function sendProgress(interaction, current, total, stats, lang) {
  await editPayload(interaction, {
    embeds: [
      createArtistEmbed(lang)
        .setTitle(`🔄 ${t('dialogue.syncImages.progressTitle', lang)}`)
        .setDescription(t('dialogue.syncImages.progressDescription', lang, { current, total }))
        .addFields(
          { name: `✅ ${t('dialogue.syncImages.fields.synced', lang)}`, value: String(stats.synced), inline: true },
          { name: `⚠️ ${t('dialogue.syncImages.fields.dead', lang)}`, value: String(stats.skippedDead), inline: true },
          { name: `🔀 ${t('dialogue.syncImages.fields.raced', lang)}`, value: String(stats.skippedRaced), inline: true },
          { name: `❌ ${t('dialogue.syncImages.fields.failed', lang)}`, value: String(stats.failed), inline: true },
        )
        .setColor(COLORS.warning)
        .setTimestamp(),
    ],
  }).catch(() => {});
}

function buildSummaryPayload(interaction, total, stats, lang) {
  const summaryColor =
    stats.failed > 0 || stats.skippedDead > 0 || stats.skippedRaced > 0
      ? COLORS.warning
      : COLORS.success;

  const summaryEmbed = createArtistEmbed(lang)
    .setTitle(`✅ ${t('dialogue.syncImages.completeTitle', lang)}`)
    .setDescription(t('dialogue.syncImages.completeDescription', lang, { total }))
    .addFields(
      { name: `✅ ${t('dialogue.syncImages.fields.synced', lang)}`, value: String(stats.synced), inline: true },
      { name: `⚠️ ${t('dialogue.syncImages.fields.dead', lang)}`, value: String(stats.skippedDead), inline: true },
      { name: `🔀 ${t('dialogue.syncImages.fields.raced', lang)}`, value: String(stats.skippedRaced), inline: true },
      { name: `❌ ${t('dialogue.syncImages.fields.failed', lang)}`, value: String(stats.failed), inline: true },
    )
    .setColor(summaryColor)
    .setFooter({ text: t('dialogue.syncImages.summaryFooter', lang, { user: interaction.user.tag }) })
    .setTimestamp();

  if (stats.errors.length > 0) {
    const errorLines = stats.errors.slice(0, 10).map((e) => `• ${e}`).join('\n');
    const truncated = stats.errors.length > 10
      ? `\n*${t('dialogue.syncImages.moreErrors', lang, { count: stats.errors.length - 10 })}*`
      : '';
    summaryEmbed.addFields({
      name: t('dialogue.syncImages.fields.errors', lang, { count: stats.errors.length }),
      value: (errorLines + truncated).slice(0, 1024),
      inline: false,
    });
  }

  const replyPayload = { embeds: [summaryEmbed] };
  if (stats.errors.length > 10) {
    const errorLines = stats.errors.map((e, i) => `${i + 1}. ${e}`).join('\n');
    const header = [
      'Sync Images - Full Error Report',
      `Date: ${new Date().toISOString()}`,
      `By: ${interaction.user.tag}`,
      `Total entries: ${total}`,
      `Synced: ${stats.synced} | Dead: ${stats.skippedDead} | Raced: ${stats.skippedRaced} | Failed: ${stats.failed}`,
      `${'-'.repeat(60)}`,
      '',
    ].join('\n');

    replyPayload.files = [
      new AttachmentBuilder(
        Buffer.from(header + errorLines, 'utf-8'),
        { name: `syncimages_errors_${new Date().toISOString().slice(0, 10)}.txt` }
      ),
    ];
  }

  return replyPayload;
}

export async function handleSyncImagesAction(interaction, lang = 'en') {
  const ownerCfg = await GuildConfig.findOne({ guildId: config.ownerGuildId }).lean();
  if (!ownerCfg?.evidenceChannelId) {
    await editPayload(interaction, {
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.ERROR,
        ...t('dialogue.syncImages.missingChannel', lang),
        lang,
      })],
    });
    return;
  }

  const legacyFilter = {
    imageUrl: { $nin: ['', null] },
    $or: [{ imageMessageId: '' }, { imageMessageId: { $exists: false } }],
  };
  const [blackLegacy, whiteLegacy, watchLegacy] = await Promise.all([
    Blacklist.find(legacyFilter).lean(),
    Whitelist.find(legacyFilter).lean(),
    Watchlist.find(legacyFilter).lean(),
  ]);
  const legacyEntries = [
    ...blackLegacy.map((e) => ({ entry: e, model: Blacklist, type: 'black' })),
    ...whiteLegacy.map((e) => ({ entry: e, model: Whitelist, type: 'white' })),
    ...watchLegacy.map((e) => ({ entry: e, model: Watchlist, type: 'watch' })),
  ];

  if (legacyEntries.length === 0) {
    await editPayload(interaction, {
      embeds: [
        createArtistEmbed(lang)
          .setTitle(`✅ ${t('dialogue.syncImages.nothingTitle', lang)}`)
          .setDescription(t('dialogue.syncImages.nothingDescription', lang))
          .setColor(COLORS.success)
          .setFooter({ text: t('dialogue.syncImages.nothingFooter', lang) })
          .setTimestamp(),
      ],
    });
    return;
  }

  await editPayload(interaction, {
    embeds: [
      createArtistEmbed(lang)
        .setTitle(`🔄 ${t('dialogue.syncImages.startingTitle', lang)}`)
        .setDescription(t('dialogue.syncImages.startingDescription', lang, { count: legacyEntries.length }))
        .addFields(
          { name: t('dialogue.syncImages.fields.blacklist', lang), value: String(blackLegacy.length), inline: true },
          { name: t('dialogue.syncImages.fields.whitelist', lang), value: String(whiteLegacy.length), inline: true },
          { name: t('dialogue.syncImages.fields.watchlist', lang), value: String(watchLegacy.length), inline: true },
        )
        .setColor(COLORS.warning)
        .setFooter({ text: t('dialogue.syncImages.startingFooter', lang) })
        .setTimestamp(),
    ],
  });

  const stats = { synced: 0, skippedDead: 0, skippedRaced: 0, failed: 0, errors: [] };

  for (let i = 0; i < legacyEntries.length; i++) {
    const { entry, model, type } = legacyEntries[i];

    try {
      const downloadUrl = await resolveDownloadUrl(entry, interaction, stats);
      if (!downloadUrl) continue;

      const rehosted = await rehostWithRetry(downloadUrl, entry, type, interaction, stats);
      if (!rehosted) continue;

      await markEntryAsRehosted(model, entry, rehosted, stats);
    } catch (err) {
      stats.failed += 1;
      stats.errors.push(`${entry.name}: ${err.message}`);
      console.warn(`[syncimages] Entry ${entry.name} failed:`, err.message);
    }

    if (i < legacyEntries.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }

    if ((i + 1) % 10 === 0 && i + 1 < legacyEntries.length) {
      await sendProgress(interaction, i + 1, legacyEntries.length, stats, lang);
    }
  }

  await editPayload(interaction, buildSummaryPayload(interaction, legacyEntries.length, stats, lang));
  console.log(`[syncimages] Done by ${interaction.user.tag}: ${stats.synced} synced, ${stats.skippedDead} dead, ${stats.skippedRaced} raced, ${stats.failed} failed`);
}
