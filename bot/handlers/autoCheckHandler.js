/**
 * autoCheckHandler.js
 * Listens for image attachments in a designated channel and
 * automatically runs listcheck (Gemini OCR → blacklist/whitelist check).
 */

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  detectAltsViaStronghold,
} from '../services/rosterService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
} from '../utils/names.js';

/**
 * Extract names from image using Gemini (reuses logic from listHandlers).
 * Kept as a local helper to avoid circular dependency with listHandlers.
 */
async function extractNamesFromImage(image) {
  if (!config.geminiApiKey) return [];

  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  if (!imageRes.ok) return [];

  const contentLength = imageRes.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 20 * 1024 * 1024) return [];

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const imageBase64 = imageBuffer.toString('base64');

  const prompt = [
    'This is a screenshot of a Lost Ark raid waiting room (party finder lobby).',
    'Extract ONLY the player character names from the party member list.',
    'Ignore all other text: raid names, class names, item levels, buttons, chat messages, server/world names (e.g. Vairgrys, Brelshaza, Thaemine).',
    'Preserve every character exactly as shown, including special letters and diacritics.',
    'Keep umlaut letters exactly: ë, ö, ü.',
    'Do NOT convert umlauts to grave-accent letters: ë!=è, ö!=ò, ü!=ù.',
    'Return JSON array only, no markdown, no explanation.',
    'Example output: ["name1","name2"].',
    'If no valid names are found, return [].',
  ].join(' ');

  const requestBody = {
    contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType, data: imageBase64 } }] }],
    generationConfig: { temperature: 0, topP: 0.1, maxOutputTokens: 512 },
  };

  const models = config.geminiModels.length > 0
    ? config.geminiModels
    : ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3-flash'];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    try {
      const aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });

      if (!aiRes.ok) {
        if (i < models.length - 1) continue;
        return [];
      }

      const payload = await aiRes.json();
      const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? '').join('').trim();
      if (!text) return [];

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return [];

      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) return [];

      const SERVER_NAMES = new Set([
        'azena', 'avesta', 'galatur', 'karta', 'ladon', 'kharmine',
        'una', 'regulus', 'sasha', 'vykas', 'elgacia', 'thaemine',
        'brelshaza', 'kazeros', 'arcturus', 'enviska', 'valtan', 'mari',
        'akkan', 'vairgrys', 'bergstrom', 'danube', 'mokoko',
      ]);

      const names = parsed
        .map((item) => (typeof item === 'string' ? normalizeCharacterName(item) : ''))
        .filter((name) => name && !SERVER_NAMES.has(name.toLowerCase()));

      const seen = new Set();
      return names.filter((n) => {
        const key = n.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } catch {
      if (i < models.length - 1) continue;
      return [];
    }
  }

  return [];
}

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

    // Show loading indicator immediately
    await message.react('🔍').catch(() => {});

    try {
      const names = await extractNamesFromImage(image);

      if (names.length === 0) {
        await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});
        return;
      }

      const limitedNames = names.slice(0, 8);
      await connectDB();

      const results = await Promise.all(
        limitedNames.map(async (name) => {
          const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
            Blacklist.findOne({ $or: [{ name }, { allCharacters: name }] })
              .collation({ locale: 'en', strength: 2 })
              .lean(),
            Whitelist.findOne({ $or: [{ name }, { allCharacters: name }] })
              .collation({ locale: 'en', strength: 2 })
              .lean(),
            Watchlist.findOne({ $or: [{ name }, { allCharacters: name }] })
              .collation({ locale: 'en', strength: 2 })
              .lean(),
          ]);

          let hasRoster = false;
          let failReason = null;
          let similarNames = null;
          if (!blackEntry && !whiteEntry && !watchEntry) {
            const rosterResult = await buildRosterCharacters(name);
            hasRoster = rosterResult.hasValidRoster;
            failReason = rosterResult.failReason;

            if (!hasRoster) {
              const suggestions = await fetchNameSuggestions(name);
              const similarCandidates = suggestions
                .filter((s) => Number(s.itemLevel || 0) >= 1700 && s.name.toLowerCase() !== name.toLowerCase())
                .slice(0, 3);

              if (similarCandidates.length > 0) {
                similarNames = await Promise.all(
                  similarCandidates.map(async (s) => {
                    const [b, w, wa] = await Promise.all([
                      Blacklist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
                        .collation({ locale: 'en', strength: 2 }).lean(),
                      Whitelist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
                        .collation({ locale: 'en', strength: 2 }).lean(),
                      Watchlist.findOne({ $or: [{ name: s.name }, { allCharacters: s.name }] })
                        .collation({ locale: 'en', strength: 2 }).lean(),
                    ]);
                    let flag = '';
                    if (b) flag += '⛔';
                    if (w) flag += '✅';
                    if (wa) flag += '⚠️';
                    if (!flag) flag = '❓';
                    return { name: s.name, flag };
                  })
                );
              }
            }
          }

          return { name, similarNames, blackEntry, whiteEntry, watchEntry, hasRoster, failReason };
        })
      );

      const lines = results.map((item, idx) => {
        const isBlack = Boolean(item.blackEntry);
        const isWhite = Boolean(item.whiteEntry);
        const isWatch = Boolean(item.watchEntry);

        const reasonParts = [];
        for (const [entry, label] of [[item.blackEntry, 'black'], [item.whiteEntry, 'white'], [item.watchEntry, 'watch']]) {
          if (!entry) continue;
          const details = [];
          if (entry.reason?.trim()) details.push(entry.reason.trim());
          const addedBy = getAddedByDisplay(entry);
          if (addedBy) details.push(`Added by: **${addedBy}**`);
          if (details.length > 0) reasonParts.push(details.join(' — '));
        }

        const reasonSuffix = reasonParts.length > 0 ? ` — ${reasonParts.join(' | ')}` : '';

        let icon = '';
        if (isBlack) icon += '⛔';
        if (isWhite) icon += '✅';
        if (isWatch) icon += '⚠️';

        if (icon) {
          return `${idx + 1}. ${icon} **${item.name}**${reasonSuffix}`;
        } else if (item.hasRoster) {
          return `${idx + 1}. ❓ **${item.name}**`;
        } else {
          const reason = item.failReason ? ` *(${item.failReason})*` : '';
          const similar = item.similarNames?.length > 0
            ? ` — Similar: ${item.similarNames.map((s) => `${s.flag} ${s.name}`).join(', ')}`
            : '';
          return `${idx + 1}. No roster found: **${item.name}**${reason}${similar}`;
        }
      });

      const content = [
        `🔍 Auto-check: **${limitedNames.length}** name(s)`,
        '',
        ...lines,
      ].join('\n');

      await message.reply({ content });
      await message.reactions.cache.get('🔍')?.users.remove(client.user.id).catch(() => {});

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
                  const model = item.blackEntry ? Blacklist : Whitelist;
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
