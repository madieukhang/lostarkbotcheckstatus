/**
 * autoCheckHandler.js
 * Listens for image attachments in designated channels and
 * automatically runs listcheck (Gemini OCR → blacklist/whitelist/watchlist check).
 *
 * Channel resolution (per message):
 *   1. Check GuildConfig in DB for this guild's autoCheckChannelId
 *   2. Fallback to AUTO_CHECK_CHANNEL_IDS env var (global)
 */

import { ActionRowBuilder, Events, StringSelectMenuBuilder } from 'discord.js';
import config from '../config.js';
import GuildConfig from '../models/GuildConfig.js';
import Blacklist from '../models/Blacklist.js';
import Whitelist from '../models/Whitelist.js';
import Watchlist from '../models/Watchlist.js';
import { detectAltsViaStronghold } from '../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../services/listCheckService.js';
import { truncateDiscordContent } from '../utils/discordText.js';

/** Env-based channel set (global fallback) */
const envChannelSet = new Set(config.autoCheckChannelIds);

/** Per-user cooldown to prevent spam (userId → timestamp) */
const userCooldowns = new Map();
const COOLDOWN_MS = 10_000; // 10 seconds between checks per user

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
      const guildConfig = await GuildConfig.findOne({ guildId }).lean();
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
    console.log('[auto-check] GEMINI_API_KEY not set — disabled.');
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

    // Check if this channel is configured for auto-check
    const isActive = await isAutoCheckChannel(message.channelId, message.guild.id);
    if (!isActive) return;

    // Per-user cooldown to prevent spam
    const lastCheck = userCooldowns.get(message.author.id) || 0;
    if (Date.now() - lastCheck < COOLDOWN_MS) return;
    userCooldowns.set(message.author.id, Date.now());

    const image = images.first();
    console.log(`[auto-check] Image detected from ${message.author.tag} in #${message.channel.name}, processing...`);

    await message.react('🔍').catch(() => {});

    try {
      const names = await extractNamesFromImage(image);

      if (names.length === 0) {
        await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
        return;
      }

      const limitedNames = names.slice(0, 8);

      // Send progress message immediately after OCR
      const progressMsg = await message.reply({
        content: `🔍 Extracted **${limitedNames.length}** name(s) — checking lists & roster...`,
      });

      const results = await checkNamesAgainstLists(limitedNames, { guildId: message.guild.id });
      const lines = formatCheckResults(results);

      const content = truncateDiscordContent([
        `🔍 Auto-check: **${limitedNames.length}** name(s)`,
        '',
        ...lines,
      ].join('\n'));

      // Build quick-add select menu for unflagged names (❓ or ⚪)
      const unflaggedNames = results.filter(
        (r) => !r.blackEntry && !r.whiteEntry && !r.watchEntry
      );
      const components = [];

      if (unflaggedNames.length > 0) {
        const selectRow = new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('quickadd_select')
            .setPlaceholder('⚡ Quick Add to List — select a name')
            .addOptions(
              unflaggedNames.slice(0, 25).map((r) => ({
                label: r.name,
                description: r.hasRoster ? 'Has roster' : 'No roster found',
                value: r.name,
                emoji: r.hasRoster ? '❓' : '⚪',
              }))
            )
        );
        components.push(selectRow);
      }

      // Edit progress message with final results
      await progressMsg.edit({ content, components });
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
      await message.react('✅').catch(() => {});

      // Background enrichment for flagged entries
      const flaggedItems = results.filter((item) => item.blackEntry || item.whiteEntry || item.watchEntry);
      if (flaggedItems.length > 0) {
        (async () => {
          for (const item of flaggedItems) {
            const listEntry = item.blackEntry || item.whiteEntry || item.watchEntry;
            try {
              const altResult = await detectAltsViaStronghold(item.name);
              if (altResult && altResult.alts.length > 0) {
                const newAltNames = altResult.alts.map((a) => a.name);
                const existingAlts = listEntry.allCharacters || [];
                const merged = [...new Set([...existingAlts, item.name, ...newAltNames])];

                if (merged.length > existingAlts.length) {
                  const model = item.blackEntry ? Blacklist : item.whiteEntry ? Whitelist : Watchlist;
                  await model.updateOne(
                    { _id: listEntry._id },
                    { $set: { allCharacters: merged } }
                  );
                  console.log(`[auto-check] Enriched ${listEntry.name} allCharacters: ${existingAlts.length} → ${merged.length}`);
                }
              }
            } catch (err) {
              console.warn(`[auto-check] Alt enrichment failed for ${item.name}:`, err.message);
            }
          }
        })().catch((err) => console.error('[auto-check] Background enrichment error:', err.message));
      }
    } catch (err) {
      console.error('[auto-check] Error processing image:', err.message);
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
      await message.react('❌').catch(() => {});
      await message.reply({
        content: `❌ Auto-check failed: ${err.message}`,
      }).catch(() => {});
    }
  });
}
