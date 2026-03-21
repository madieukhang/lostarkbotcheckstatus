/**
 * autoCheckHandler.js
 * Listens for image attachments in designated channels and
 * automatically runs listcheck (Gemini OCR → blacklist/whitelist/watchlist check).
 */

import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { detectAltsViaStronghold } from '../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../services/listCheckService.js';

/**
 * Set up the auto-check message listener.
 * @param {import('discord.js').Client} client
 */
export function setupAutoCheck(client) {
  if (config.autoCheckChannelIds.length === 0) {
    console.log('[auto-check] AUTO_CHECK_CHANNEL_IDS not set — disabled.');
    return;
  }

  if (!config.geminiApiKey) {
    console.log('[auto-check] GEMINI_API_KEY not set — disabled.');
    return;
  }

  const channelSet = new Set(config.autoCheckChannelIds);
  console.log(`[auto-check] Monitoring ${channelSet.size} channel(s): ${[...channelSet].join(', ')}`);

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!channelSet.has(message.channelId)) return;

    const images = message.attachments.filter(
      (a) => a.contentType && a.contentType.startsWith('image/')
    );

    if (images.size === 0) return;

    const image = images.first();
    console.log(`[auto-check] Image detected from ${message.author.tag}, processing...`);

    await message.react('🔍').catch(() => {});

    try {
      const names = await extractNamesFromImage(image);

      if (names.length === 0) {
        await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
        return;
      }

      const limitedNames = names.slice(0, 8);
      const results = await checkNamesAgainstLists(limitedNames);
      const lines = formatCheckResults(results);

      const content = [
        `🔍 Auto-check: **${limitedNames.length}** name(s)`,
        '',
        ...lines,
      ].join('\n');

      await message.reply({ content });
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
    }
  });
}
