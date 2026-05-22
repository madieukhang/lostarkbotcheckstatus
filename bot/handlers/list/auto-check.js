/**
 * handlers/list/auto-check.js
 * Listens for image attachments in designated channels and
 * automatically runs listcheck (Gemini OCR → blacklist/whitelist/watchlist check).
 *
 * Channel resolution (per message):
 *   1. Check GuildConfig in DB for this guild's autoCheckChannelId
 *   2. Fallback to AUTO_CHECK_CHANNEL_IDS env var (global)
 */

import { ActionRowBuilder, Events, StringSelectMenuBuilder } from 'discord.js';
import config from '../../config.js';
import GuildConfig from '../../models/GuildConfig.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../services/list-check/service.js';
import { getGuildConfig } from '../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { buildListCheckEmbed } from '../../utils/listCheckEmbed.js';
import { getGuildLanguage, t } from '../../services/i18n/index.js';
import { buildAutoCheckEvidenceRow } from './check/index.js';

/** Env-based channel set (global fallback) */
const envChannelSet = new Set(config.autoCheckChannelIds);

/** Per-user cooldown to prevent spam (userId → timestamp) */
const userCooldowns = new Map();
const COOLDOWN_MS = 10_000; // 10 seconds between checks per user
const processedMessages = new Map(); // messageId -> timestamp
const inFlightMessages = new Set();
const MESSAGE_DEDUPE_TTL_MS = 10 * 60 * 1000;

function pruneProcessedMessages(now = Date.now()) {
  for (const [messageId, ts] of processedMessages) {
    if (now - ts > MESSAGE_DEDUPE_TTL_MS) {
      processedMessages.delete(messageId);
    }
  }
}

export function claimAutoCheckMessage(messageId, now = Date.now()) {
  if (!messageId) return true;
  pruneProcessedMessages(now);
  if (inFlightMessages.has(messageId) || processedMessages.has(messageId)) {
    return false;
  }
  inFlightMessages.add(messageId);
  return true;
}

export function completeAutoCheckMessage(messageId, options = {}) {
  if (!messageId) return;
  const { processed = true, now = Date.now() } = options;
  inFlightMessages.delete(messageId);
  if (processed) {
    processedMessages.set(messageId, now);
  }
}

export function resetAutoCheckDedupeForTest() {
  processedMessages.clear();
  inFlightMessages.clear();
  userCooldowns.clear();
}

/**
 * Check if a channel is configured for auto-check
 * (either via DB GuildConfig or env var fallback).
 * @param {string} channelId
 * @param {string} guildId
 * @returns {Promise<boolean>}
 */
async function isAutoCheckChannel(channelId, guildId) {
  // DB config takes priority for this guild
  if (guildId) {
    try {
      const guildConfig = await getGuildConfig(guildId);
      if (guildConfig?.autoCheckChannelId) {
        return guildConfig.autoCheckChannelId === channelId;
      }
    } catch (err) {
      console.warn('[auto-check] Failed to query GuildConfig:', err.message);
    }
  }

  // Fallback to env var
  return envChannelSet.has(channelId);
}

/**
 * Set up the auto-check message listener.
 * @param {import('discord.js').Client} client
 */
export function setupAutoCheck(client) {
  if (!config.geminiApiKey) {
    console.log('[auto-check] GEMINI_API_KEY not set · disabled.');
    return;
  }

  if (envChannelSet.size > 0) {
    console.log(`[auto-check] Env fallback channels: ${[...envChannelSet].join(', ')}`);
  }
  console.log('[auto-check] Listener active (checks DB GuildConfig + env fallback per message).');

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const images = message.attachments.filter(
      (a) => a.contentType && a.contentType.startsWith('image/')
    );

    if (images.size === 0) return;

    if (!claimAutoCheckMessage(message.id)) return;
    let shouldRememberMessage = false;

    try {
      // Check if this channel is configured for auto-check
      const isActive = await isAutoCheckChannel(message.channelId, message.guild.id);
      if (!isActive) return;
      shouldRememberMessage = true;

      // Per-user cooldown to prevent spam. The message claim above runs
      // before this async channel lookup can race with duplicate
      // MessageCreate deliveries or a duplicate listener in one process.
      const lastCheck = userCooldowns.get(message.author.id) || 0;
      if (Date.now() - lastCheck < COOLDOWN_MS) return;
      userCooldowns.set(message.author.id, Date.now());

      const image = images.first();
      console.log(`[auto-check] Image detected from ${message.author.tag} in #${message.channel.name}, processing...`);

      await message.react('🔍').catch(() => {});

      const names = await extractNamesFromImage(image);

      if (names.length === 0) {
        await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
        return;
      }

      const MAX_AUTO_NAMES = 8;
      const limitedNames = names.slice(0, MAX_AUTO_NAMES);

      // Send progress message immediately after OCR. Plain content here
      // (not an embed) because this is a transient "working on it" line
      // that gets edited into a full embed below within seconds.
      const progressMsg = await message.reply({
        content: `🔍 Extracted **${limitedNames.length}** name(s) · checking database lists...`,
      });

      const results = await checkNamesAgainstLists(limitedNames, { guildId: message.guild.id });
      const lang = await getGuildLanguage(message.guild.id, { GuildConfigModel: GuildConfig });
      const formattedLines = formatCheckResults(results);

      // Same embed builder as /la-list check; mode: 'auto' tweaks the
      // title verb ("Auto-check" vs "List Check") and the footer copy
      // (mentions the Quick-Add dropdown below).
      const { embed } = buildListCheckEmbed({
        results,
        formattedLines,
        limitedNamesCount: limitedNames.length,
        ignoredCount: names.length - limitedNames.length,
        maxNames: MAX_AUTO_NAMES,
        mode: 'auto',
      });

      // Quick-Add dropdown for names with no DB list hit. Sits below
      // the embed so an officer can add a suspicious unlisted name
      // without retyping it.
      const unflaggedNames = results.filter(
        (r) => !r.blackEntry && !r.whiteEntry && !r.watchEntry
      );
      const components = [];

      if (unflaggedNames.length > 0) {
        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('quickadd_select')
            .setPlaceholder(t('quickAdd.selectPlaceholder', lang))
            .addOptions(
              unflaggedNames.slice(0, 25).map((r) => ({
                label: r.name,
                description: t('quickAdd.noListHit', lang),
                value: r.name,
                emoji: '❓',
              }))
            )
        );
        components.push(selectRow);
      }

      // Evidence dropdown · second row when any flagged result has an
      // attached image. Mirrors /la-list view's design so officers can
      // audit evidence right from the auto-check card instead of
      // re-running /la-list view.
      const evidenceRow = buildAutoCheckEvidenceRow(results, lang);
      if (evidenceRow) components.push(evidenceRow);

      await progressMsg.edit({ content: '', embeds: [embed], components });
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
      await message.react('✅').catch(() => {});
    } catch (err) {
      console.error('[auto-check] Error processing image:', err.message);
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
      await message.react('❌').catch(() => {});
      await message.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Auto-Check Failed',
          description: 'Could not run the automatic list check on this image.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
      }).catch(() => {});
    } finally {
      completeAutoCheckMessage(message.id, { processed: shouldRememberMessage });
    }
  });
}
