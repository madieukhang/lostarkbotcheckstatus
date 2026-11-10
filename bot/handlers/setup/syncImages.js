import { AttachmentBuilder } from 'discord.js';
import { createArtistEmbed } from '../../utils/artistVoice.js';

import config from '../../config.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, NoticeKind } from '../../utils/alertEmbed.js';
import { editPayload } from '../../utils/interactionReplies.js';
import { sleep } from '../../utils/async.js';
import GuildConfig from '../../models/GuildConfig.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { copyArchiveToDatabase, refreshLegacyImageUrl, rehostImage } from '../../utils/imageRehost.js';
import { listArchivedMessageIds } from '../../utils/evidenceStore.js';
import { t } from '../../services/i18n/index.js';

// A Discord interaction token lasts 15 minutes; the copy pass starts no new
// image after 12, so the summary still reaches the user.
const SYNC_COPY_BUDGET_MS = 12 * 60 * 1000;

async function resolveDownloadUrl(entry, interaction, stats) {
  const { url, error } = await refreshLegacyImageUrl(entry.imageUrl, interaction.client);
  if (url) return url;
  stats.skippedDead += 1;
  stats.errors.push(`${entry.name}: ${error}`);
  return null;
}

// rehostImage refuses these the same way on every attempt, so a retry cannot
// help.
const PERMANENT_DOWNLOAD_FAILURES = ['download refused', 'download is not an image'];
const DEAD_LINK_FAILURES = [
  'download HTTP',
  'download fetch threw',
  'download read body',
  ...PERMANENT_DOWNLOAD_FAILURES,
];

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
      const errMsg = err.message;
      const isPermanent = PERMANENT_DOWNLOAD_FAILURES.some((prefix) => errMsg.startsWith(prefix));
      if (attempt === 1 && !isPermanent) {
        firstAttemptError = errMsg;
        await sleep(2000);
        continue;
      }

      const isDownloadFailure = DEAD_LINK_FAILURES.some((prefix) => errMsg.startsWith(prefix));

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

function buildSyncStatsFields(stats, lang) {
  return [
    { name: `✅ ${t('dialogue.syncImages.fields.synced', lang)}`, value: String(stats.synced), inline: true },
    { name: `⚠️ ${t('dialogue.syncImages.fields.dead', lang)}`, value: String(stats.skippedDead), inline: true },
    { name: `🔀 ${t('dialogue.syncImages.fields.raced', lang)}`, value: String(stats.skippedRaced), inline: true },
    { name: `❌ ${t('dialogue.syncImages.fields.failed', lang)}`, value: String(stats.failed), inline: true },
    { name: `🗄️ ${t('dialogue.syncImages.fields.copied', lang)}`, value: String(stats.copied), inline: true },
    { name: `⏭️ ${t('dialogue.syncImages.fields.copyLeft', lang)}`, value: String(stats.copyLeft), inline: true },
  ];
}

async function sendProgress(interaction, current, total, stats, lang) {
  await editPayload(interaction, {
    embeds: [
      createArtistEmbed()
        .setTitle(`🔄 ${t('dialogue.syncImages.progressTitle', lang)}`)
        .setDescription(t('dialogue.syncImages.progressDescription', lang, { current, total }))
        .addFields(...buildSyncStatsFields(stats, lang))
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

  const summaryEmbed = createArtistEmbed()
    .setTitle(`✅ ${t('dialogue.syncImages.completeTitle', lang)}`)
    // Images left for the next run were not checked in this one.
    .setDescription(t('dialogue.syncImages.completeDescription', lang, { total, copies: stats.copyTotal - stats.copyLeft }))
    .addFields(...buildSyncStatsFields(stats, lang))
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
      `Synced: ${stats.synced} | Dead: ${stats.skippedDead} | Raced: ${stats.skippedRaced} | Failed: ${stats.failed} | Copied: ${stats.copied} | Left: ${stats.copyLeft}`,
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

// Every archive message an entry points at that no stored image lists yet,
// once per message.
async function findArchiveCopyTargets() {
  const onArchive = { imageMessageId: { $nin: ['', null] }, imageChannelId: { $nin: ['', null] } };
  const [stored, ...lists] = await Promise.all([
    listArchivedMessageIds(),
    ...[Blacklist, Whitelist, Watchlist].map(model => model.find(onArchive).select('name imageMessageId imageChannelId').lean()),
  ]);
  const targets = new Map();
  for (const entry of lists.flat()) {
    if (!stored.has(entry.imageMessageId) && !targets.has(entry.imageMessageId)) {
      targets.set(entry.imageMessageId, entry);
    }
  }
  return [...targets.values()];
}

async function runLegacyPass(legacyEntries, interaction, stats, lang) {
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
      await sleep(500);
    }

    if ((i + 1) % 10 === 0 && i + 1 < legacyEntries.length) {
      await sendProgress(interaction, i + 1, legacyEntries.length, stats, lang);
    }
  }
}

// The summary counter a copy result adds to; any other status is a failure.
const COPY_RESULT_COUNTER = Object.freeze({ stored: 'copied', gone: 'skippedDead' });

// Copies archived images into the database until the budget runs out; the
// rest are counted as left for the next run, which selects them again.
async function runCopyPass(targets, interaction, stats, lang, { startedAt, now, copyBudgetMs }) {
  for (let i = 0; i < targets.length; i++) {
    if (now() - startedAt >= copyBudgetMs) {
      stats.copyLeft = targets.length - i;
      return;
    }
    const { name, imageMessageId, imageChannelId } = targets[i];
    const result = await copyArchiveToDatabase(imageMessageId, imageChannelId, interaction.client);
    stats[COPY_RESULT_COUNTER[result.status] || 'failed'] += 1;
    if (result.status !== 'stored') stats.errors.push(`${name}: ${result.error}`);

    if (i < targets.length - 1) await sleep(500);
    if ((i + 1) % 10 === 0 && i + 1 < targets.length) {
      await sendProgress(interaction, i + 1, targets.length, stats, lang);
    }
  }
}

/**
 * /la-remote action:syncimages: rehost legacy direct links into the evidence
 * archive, then copy archived images the database does not hold yet.
 * @param {import('discord.js').Interaction} interaction - the deferred command
 * @param {string} [lang='en'] - reply language
 * @param {object} [options]
 * @param {Function} [options.now=Date.now] - clock for the copy budget
 * @param {number} [options.copyBudgetMs=SYNC_COPY_BUDGET_MS] - time after
 *   which the copy pass starts no new image
 * @returns {Promise<void>}
 */
export async function handleSyncImagesAction(interaction, lang = 'en', {
  now = Date.now,
  copyBudgetMs = SYNC_COPY_BUDGET_MS,
} = {}) {
  const startedAt = now();
  const ownerCfg = await GuildConfig.findOne({ guildId: config.ownerGuildId }).lean();
  if (!ownerCfg?.evidenceChannelId) {
    await editPayload(interaction, {
      embeds: [buildAlertEmbed({
        kind: NoticeKind.INPUT,
        ...t('dialogue.syncImages.missingChannel', lang),
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

  const copyTargets = await findArchiveCopyTargets();
  if (legacyEntries.length === 0 && copyTargets.length === 0) {
    await editPayload(interaction, {
      embeds: [
        createArtistEmbed()
          .setTitle(`✅ ${t('dialogue.syncImages.nothingTitle', lang)}`)
          .setDescription(t('dialogue.syncImages.nothingDescription', lang))
          .setColor(COLORS.success)
          .setFooter({ text: t('dialogue.syncImages.nothingFooter', lang) })
          .setTimestamp(),
      ],
    });
    return;
  }

  const stats = {
    synced: 0, skippedDead: 0, skippedRaced: 0, failed: 0,
    copied: 0, copyLeft: 0, copyTotal: copyTargets.length, errors: [],
  };

  if (legacyEntries.length > 0) {
    await editPayload(interaction, {
      embeds: [
        createArtistEmbed()
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
    await runLegacyPass(legacyEntries, interaction, stats, lang);
  }

  await runCopyPass(copyTargets, interaction, stats, lang, { startedAt, now, copyBudgetMs });

  try {
    await editPayload(interaction, buildSummaryPayload(interaction, legacyEntries.length, stats, lang));
  } catch (err) {
    console.warn('[syncimages] Summary edit failed:', err.message);
  }
  console.log(`[syncimages] Done by ${interaction.user.tag}: ${stats.synced} synced, ${stats.skippedDead} dead, ${stats.skippedRaced} raced, ${stats.failed} failed, ${stats.copied} copied, ${stats.copyLeft} left`);
}
