import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import PendingApproval from '../../models/PendingApproval.js';
import { getClassName } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  detectAltsViaStronghold,
} from '../services/rosterService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../utils/names.js';

// Hardcoded approver IDs for /list add proposal flow.
// - SENIOR_APPROVER_ID alone is sufficient for approval routing.
// - One random ID from OFFICER_APPROVER_IDS is optional and also gets the approval DM.
const OFFICER_APPROVER_IDS = [
  '338779757510524928', // Khoai
  '287894237587046400', // KilZ
];
const SENIOR_APPROVER_ID = '324502048102154241';
const MEMBER_APPROVER_IDS = [
  '1272458473493499904', // Bonnie
];

function getListContext(type) {
  if (type === 'black') {
    return { model: Blacklist, label: 'blacklist', color: 0xed4245, icon: '⛔' };
  }
  if (type === 'watch') {
    return { model: Watchlist, label: 'watchlist', color: 0xfee75c, icon: '⚠️' };
  }
  return { model: Whitelist, label: 'whitelist', color: 0x57f287, icon: '✅' };
}

function extractJsonArrayFromText(raw) {
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  const match = trimmed.match(/\[[\s\S]*\]/);
  return match ? match[0] : null;
}

function shouldFailoverGeminiModel(status, bodyText) {
  const text = (bodyText || '').toLowerCase();
  if (status === 429 || status === 503) return true;
  return (
    text.includes('resource_exhausted') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('too many requests')
  );
}

function buildGeminiRequestBody(mimeType, imageBase64) {
  const prompt = [
    'This is a screenshot of a Lost Ark raid waiting room (party finder lobby).',
    'Extract ONLY the player character names from the party member list.',
    'Ignore all other text: raid names, class names, item levels, buttons, chat messages, server/world names (e.g. Vairgrys, Brelshaza, Thaemine).',
    'Preserve every character exactly as shown, including special letters and diacritics.',
    'Lost Ark names frequently use diacritics: ë, ï, ö, ü, í, é, â, î. Pay close attention to dots/marks above letters.',
    'Keep umlaut letters exactly: ë, ö, ü.',
    'Do NOT convert umlauts to grave-accent letters: ë!=è, ö!=ò, ü!=ù.',
    'Return JSON array only, no markdown, no explanation.',
    'Example output: ["name1","name2"].',
    'If no valid names are found, return [].',
  ].join(' ');

  return {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      topP: 0.1,
      maxOutputTokens: 512,
    },
  };
}

function parseGeminiNamesFromPayload(payload) {
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text ?? '')
    .join('')
    .trim();

  if (!text) return [];

  const jsonArrayText = extractJsonArrayFromText(text);
  if (!jsonArrayText) {
    throw new Error('Gemini did not return a JSON array.');
  }

  const parsed = JSON.parse(jsonArrayText);
  if (!Array.isArray(parsed)) {
    throw new Error('Gemini output is not an array.');
  }

  // Known Lost Ark server/world names to filter out from OCR results
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
  const unique = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return unique;
}

async function extractNamesFromImageWithGemini(image) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured.');
  }

  if (image.contentType && !image.contentType.startsWith('image/')) {
    throw new Error('Attachment must be an image file.');
  }

  const imageRes = await fetch(image.url, { signal: AbortSignal.timeout(15000) });
  if (!imageRes.ok) {
    throw new Error(`Failed to download attachment (HTTP ${imageRes.status})`);
  }

  const contentLength = imageRes.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > 20 * 1024 * 1024) {
    throw new Error('Image file too large (max 20MB).');
  }

  const mimeType = image.contentType || imageRes.headers.get('content-type') || 'image/png';
  const imageBuffer = Buffer.from(await imageRes.arrayBuffer());
  const imageBase64 = imageBuffer.toString('base64');

  const models = config.geminiModels.length > 0
    ? config.geminiModels
    : ['gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-3-flash'];
  const requestBody = buildGeminiRequestBody(mimeType, imageBase64);
  const failures = [];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;

    let aiRes;
    try {
      aiRes = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });
    } catch (fetchErr) {
      // Timeout or network error — try next model if available
      failures.push(`${model}: ${fetchErr.name || fetchErr.message}`);
      const canFallback = i < models.length - 1;
      if (canFallback) {
        console.warn(`[listcheck] Gemini timeout/network error on ${model}, trying fallback model.`);
        continue;
      }
      throw new Error(`Gemini request failed on ${model}: ${fetchErr.message}`);
    }

    if (!aiRes.ok) {
      const errBody = await aiRes.text().catch(() => '');
      failures.push(`${model}: HTTP ${aiRes.status}`);

      const canFallback = i < models.length - 1;
      if (canFallback && shouldFailoverGeminiModel(aiRes.status, errBody)) {
        console.warn(`[listcheck] Gemini quota/rate hit on ${model}, trying fallback model.`);
        continue;
      }

      throw new Error(`Gemini request failed on ${model} (HTTP ${aiRes.status}) ${errBody}`.trim());
    }

    const payload = await aiRes.json();
    return parseGeminiNamesFromPayload(payload);
  }

  throw new Error(`All Gemini models failed: ${failures.join(' | ')}`);
}

function buildListAddApprovalEmbed(guild, payload, options = {}) {
  const title = options.title || 'List add approval required';
  const includeRequestedBy = options.includeRequestedBy ?? true;
  const fields = [
    { name: 'Request ID', value: payload.requestId, inline: false },
    { name: 'Type', value: payload.type, inline: true },
    { name: 'Name', value: payload.name, inline: true },
    { name: 'Raid', value: payload.raid || 'N/A', inline: true },
    { name: 'Reason', value: payload.reason, inline: false },
  ];

  if (includeRequestedBy) {
    fields.push({
      name: 'Requested by',
      value: `${payload.requestedByDisplayName} (<@${payload.requestedByUserId}>)`,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(`A new list add request was submitted in **${guild.name}**.`)
    .addFields(fields)
    .setColor(payload.type === 'black' ? 0xed4245 : 0x57f287)
    .setTimestamp(new Date());

  if (payload.imageUrl) {
    embed.setImage(payload.imageUrl);
  }

  return embed;
}

function getApproverRecipientIds() {
  const officers = OFFICER_APPROVER_IDS.filter(Boolean);
  const recipientIds = [];

  if (SENIOR_APPROVER_ID) {
    recipientIds.push(SENIOR_APPROVER_ID);
  }

  if (officers.length > 0) {
    const randomOfficerId = officers[Math.floor(Math.random() * officers.length)];
    if (!recipientIds.includes(randomOfficerId)) {
      recipientIds.push(randomOfficerId);
    }
  }

  return recipientIds;
}

function isRequesterAutoApprover(userId) {
  if (!userId) return false;
  if (SENIOR_APPROVER_ID === userId) return true;
  if (OFFICER_APPROVER_IDS.includes(userId)) return true;
  return MEMBER_APPROVER_IDS.includes(userId);
}

function buildApprovalResultRow(actionLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_approved_done')
      .setLabel(actionLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

function buildApprovalProcessingRow(action) {
  const isApprove = action === 'listadd_approve';

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_processing_approve')
      .setLabel(isApprove ? 'Approving...' : 'Approve')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('listadd_processing_reject')
      .setLabel(!isApprove ? 'Rejecting...' : 'Reject')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true)
  );
}

export function createListHandlers({ client }) {

  async function sendListAddApprovalToApprovers(guild, payload) {
    const approverIds = getApproverRecipientIds();
    if (approverIds.length === 0) {
      return { success: false, reason: 'No approver user IDs configured. Set SENIOR_APPROVER_ID or OFFICER_APPROVER_IDS.' };
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`listadd_approve:${payload.requestId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`listadd_reject:${payload.requestId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger)
    );

    const embed = buildListAddApprovalEmbed(guild, payload);
    const deliveredApproverIds = [];
    const deliveredDmMessages = [];

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;

          const sentMessage = await user.send({ embeds: [embed], components: [row] });
          deliveredApproverIds.push(user.id);
          deliveredDmMessages.push({
            approverId: user.id,
            channelId: sentMessage.channelId,
            messageId: sentMessage.id,
          });
        } catch (err) {
          console.warn(`[list] Failed to DM approver ${approverId}:`, err.message);
        }
      })
    );

    if (deliveredApproverIds.length === 0) {
      return { success: false, reason: 'Unable to DM configured approvers. Check user IDs/privacy settings.' };
    }

    return { success: true, deliveredApproverIds, deliveredDmMessages };
  }

  async function syncApproverDmMessages(payload, messageOptions, options = {}) {
    const refs = payload.approverDmMessages || [];
    if (refs.length === 0) return;

    const excludeMessageId = options.excludeMessageId || '';

    await Promise.all(
      refs.map(async (ref) => {
        if (!ref?.channelId || !ref?.messageId) return;
        if (excludeMessageId && ref.messageId === excludeMessageId) return;

        try {
          const dmChannel = await client.channels.fetch(ref.channelId);
          if (!dmChannel || !dmChannel.isTextBased()) return;

          const dmMessage = await dmChannel.messages.fetch(ref.messageId);
          await dmMessage.edit(messageOptions);
        } catch (err) {
          console.warn(`[list] Failed to sync approver DM ${ref.messageId}:`, err.message);
        }
      })
    );
  }

  async function executeListAddToDatabase(payload) {
    const { model, label, color, icon } = getListContext(payload.type);
    const name = normalizeCharacterName(payload.name);

    const { hasValidRoster, allCharacters } = await buildRosterCharacters(name);
    if (!hasValidRoster) {
      const suggestions = await fetchNameSuggestions(name);
      if (suggestions.length > 0) {
        const suggestionLines = suggestions
          .slice(0, 10)
          .map(
            (s, idx) =>
              `**${idx + 1}.** [${s.name}](https://lostark.bible/character/NA/${encodeURIComponent(s.name)}/roster) — \`${Number(s.itemLevel || 0).toFixed(2)}\` — ${getClassName(s.cls)}`
          )
          .join('\n');

        const suggEmbed = new EmbedBuilder()
          .setTitle('No roster found')
          .setDescription(suggestionLines)
          .setColor(0xfee75c)
          .setTimestamp();

        return {
          ok: false,
          content: `❌ No roster found for **${name}**. Use one of the suggested names.`,
          embeds: [suggEmbed],
        };
      }

      return {
        ok: false,
        content: `❌ No roster found for **${name}**, and no similar name suggestions were found.`,
        embeds: [],
      };
    }

    await connectDB();

    const existed = await model.findOne({
      $or: [{ name }, { allCharacters: name }],
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (existed) {
      return {
        ok: false,
        content: `⚠️ **${name}** already exists in ${label}.`,
        embeds: [],
      };
    }

    const entry = await model.create({
      name,
      reason: payload.reason,
      raid: payload.raid,
      imageUrl: payload.imageUrl,
      allCharacters,
      addedByUserId: payload.requestedByUserId,
      addedByTag: payload.requestedByTag,
      addedByName: payload.requestedByName,
      addedByDisplayName: payload.requestedByDisplayName,
    });

    const embed = new EmbedBuilder()
      .setTitle(`${label} entry added`)
      .addFields(
        { name: 'Name', value: entry.name, inline: true },
        { name: 'Reason', value: payload.reason || 'N/A', inline: true },
        { name: 'Raid', value: payload.raid || 'N/A', inline: true },
        { name: 'All Characters', value: String(allCharacters.length), inline: true }
      )
      .setColor(color)
      .setTimestamp(new Date());

    if (payload.imageUrl) {
      embed.setImage(payload.imageUrl);
    }

    return {
      ok: true,
      content: `${icon} Added **${entry.name}** to ${label}.`,
      embeds: [embed],
    };
  }

  async function notifyRequesterAboutDecision(payload, result, rejected = false) {
    try {
      const guild = await client.guilds.fetch(payload.guildId);
      const channel = await guild.channels.fetch(payload.channelId);

      if (!channel || !channel.isTextBased()) return;

      const decisionContent = rejected
        ? `<@${payload.requestedByUserId}> ❌ Your list add request for **${payload.name}** was rejected by Officer.`
        : `<@${payload.requestedByUserId}> ${result.content}`;

      const decisionPayload = {
        content: decisionContent,
        embeds: rejected ? [] : (result.embeds ?? []),
      };

      if (payload.requestMessageId && 'messages' in channel) {
        try {
          const requestMessage = await channel.messages.fetch(payload.requestMessageId);
          await requestMessage.reply(decisionPayload);
          return;
        } catch (err) {
          console.warn('[list] Failed to reply on original request message, falling back to channel send:', err.message);
        }
      }

      await channel.send(decisionPayload);
    } catch (err) {
      console.warn('[list] Failed to notify requester in origin channel:', err.message);
    }
  }

  async function handleListAddApprovalButton(interaction) {
    const [action, requestId] = interaction.customId.split(':');
    await connectDB();
    const payload = await PendingApproval.findOneAndDelete({
      requestId,
      approverIds: interaction.user.id,
    }).lean();

    if (!payload) {
      const stillExists = await PendingApproval.exists({ requestId });

      if (stillExists) {
        await interaction.reply({
          content: '⛔ You are not allowed to approve/reject this request.',
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: '⚠️ This approval request was already processed or has expired.',
        ephemeral: true,
      });
      return;
    }

    const isApproveAction = action === 'listadd_approve';

    // Acknowledge immediately, then show processing state to avoid 3s timeout issues.
    await interaction.deferUpdate();

    await interaction.editReply({
      content: isApproveAction
        ? `⏳ Processing approval by **${interaction.user.tag}**...`
        : `⏳ Processing rejection by **${interaction.user.tag}**...`,
      components: [buildApprovalProcessingRow(action)],
    });

    await syncApproverDmMessages(
      payload,
      {
        content: isApproveAction
          ? `⏳ Processing approval by **${interaction.user.tag}**...`
          : `⏳ Processing rejection by **${interaction.user.tag}**...`,
        components: [buildApprovalProcessingRow(action)],
      },
      { excludeMessageId: interaction.message.id }
    );

    if (!isApproveAction) {
      await interaction.editReply({
        content: `❌ Rejected by **${interaction.user.tag}**`,
        components: [buildApprovalResultRow('Rejected')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `❌ Rejected by **${interaction.user.tag}**`,
          components: [buildApprovalResultRow('Rejected')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    try {
      const result = await executeListAddToDatabase(payload);
      await interaction.editReply({
        content: result.ok
          ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
          : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: result.ok
            ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
            : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
          components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(payload, result, false);
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
        components: [buildApprovalResultRow('Failed')],
      });

      await syncApproverDmMessages(
        payload,
        {
          content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
          components: [buildApprovalResultRow('Failed')],
        },
        { excludeMessageId: interaction.message.id }
      );

      await notifyRequesterAboutDecision(
        payload,
        { content: `⚠️ Failed to execute approved request: \`${err.message}\``, embeds: [] },
        false
      );
    }
  }

  async function handleListCheckCommand(interaction) {
    const image = interaction.options.getAttachment('image', true);
    let names = [];

    await interaction.deferReply();

    try {
      names = await extractNamesFromImageWithGemini(image);
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ Failed to extract names from image: \`${err.message}\``,
      });
      return;
    }

    if (names.length === 0) {
      await interaction.editReply({
        content: '⚠️ No valid names found in the uploaded image. Please use a clearer screenshot.',
      });
      return;
    }

    const limitedNames = names.slice(0, 8);

    try {
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
          let correctedName = null;
          let failReason = null;
          if (!blackEntry && !whiteEntry && !watchEntry) {
            const rosterResult = await buildRosterCharacters(name);
            hasRoster = rosterResult.hasValidRoster;
            failReason = rosterResult.failReason;

            // OCR correction: if no roster, search for similar names (handles missed diacritics)
            if (!hasRoster) {
              const suggestions = await fetchNameSuggestions(name);
              const topMatch = suggestions.find((s) => Number(s.itemLevel || 0) >= 1700);
              if (topMatch && topMatch.name.toLowerCase() !== name.toLowerCase()) {
                correctedName = topMatch.name;
                // Re-check lists with corrected name
                const [corrBlack, corrWhite, corrWatch] = await Promise.all([
                  Blacklist.findOne({ $or: [{ name: correctedName }, { allCharacters: correctedName }] })
                    .collation({ locale: 'en', strength: 2 }).lean(),
                  Whitelist.findOne({ $or: [{ name: correctedName }, { allCharacters: correctedName }] })
                    .collation({ locale: 'en', strength: 2 }).lean(),
                  Watchlist.findOne({ $or: [{ name: correctedName }, { allCharacters: correctedName }] })
                    .collation({ locale: 'en', strength: 2 }).lean(),
                ]);
                return { name, correctedName, blackEntry: corrBlack, whiteEntry: corrWhite, watchEntry: corrWatch, hasRoster: true };
              }
            }
          }

          return { name, correctedName, blackEntry, whiteEntry, watchEntry, hasRoster, failReason };
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
          if (details.length > 0) reasonParts.push(`${label}: ${details.join(' — ')}`);
        }

        const reasonSuffix = reasonParts.length > 0 ? ` — ${reasonParts.join(' | ')}` : '';

        let icon = '';
        if (isBlack) icon += '⛔';
        if (isWhite) icon += '✅';
        if (isWatch) icon += '⚠️';

        const displayName = item.correctedName
          ? `**${item.correctedName}** *(OCR: ${item.name})*`
          : `**${item.name}**`;

        if (icon) {
          return `${idx + 1}. ${icon} ${displayName}${reasonSuffix}`;
        } else if (item.hasRoster) {
          return `${idx + 1}. ❓ ${displayName}`;
        } else {
          const reason = item.failReason ? ` *(${item.failReason})*` : '';
          return `${idx + 1}. No roster found: **${item.name}**${reason}`;
        }
      });

      const sections = [
        `Checked: **${limitedNames.length}** name(s)`,
        limitedNames.length < names.length ? `Ignored: **${names.length - limitedNames.length}** extra name(s) (limit: 8)` : null,
        '',
        ...lines,
      ].filter((line) => line !== null);

      await interaction.editReply({
        content: sections.join('\n'),
      });

      // Fire-and-forget: enrich allCharacters in background for flagged entries
      const flaggedItems = results.filter((item) => item.blackEntry || item.whiteEntry);
      if (flaggedItems.length > 0) {
        (async () => {
          for (const item of flaggedItems) {
            const listEntry = item.blackEntry || item.whiteEntry;
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
                  console.log(`[listcheck] Enriched ${listEntry.name} allCharacters: ${existingAlts.length} → ${merged.length}`);
                }
              }
            } catch (err) {
              console.warn(`[listcheck] Alt enrichment failed for ${item.name}:`, err.message);
            }
          }
        })().catch((err) => console.error('[listcheck] Background enrichment error:', err.message));
      }
    } catch (err) {
      console.error('[listcheck] ❌ Check failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to run list check: \`${err.message}\``,
      });
    }
  }

  async function handleListAddCommand(interaction) {
    const type = interaction.options.getString('type', true);
    const rawName = interaction.options.getString('name', true).trim();
    const reason = interaction.options.getString('reason', true).trim();
    const raid = interaction.options.getString('raid') ?? '';
    const image = interaction.options.getAttachment('image');
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    if (!interaction.guild) {
      await interaction.editReply({
        content: '❌ This command can only be used in a server.',
      });
      return;
    }

    if (!reason) {
      await interaction.editReply({
        content: '❌ Reason cannot be empty.',
      });
      return;
    }

    if (image?.contentType && !image.contentType.startsWith('image/')) {
      await interaction.editReply({
        content: '❌ Attachment must be an image file.',
      });
      return;
    }

    try {
      const requestId = randomUUID();
      const payload = {
        requestId,
        guildId: interaction.guild.id,
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        imageUrl: image?.url ?? '',
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: getInteractionDisplayName(interaction),
        createdAt: Date.now(),
      };

      if (isRequesterAutoApprover(payload.requestedByUserId)) {
        const result = await executeListAddToDatabase(payload);
        await interaction.editReply({
          content: `${result.content}`,
          embeds: result.embeds ?? [],
        });
        return;
      }

      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({
          content: `⚠️ Failed to send approval request to approvers: ${sent.reason}`,
        });
        return;
      }

      await connectDB();
      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        embeds: [
          buildListAddApprovalEmbed(interaction.guild, payload, {
            title: 'List add proposal submitted',
            includeRequestedBy: false,
          }),
        ],
      });

      try {
        const requestReply = await interaction.fetchReply();
        await PendingApproval.updateOne(
          { requestId },
          { $set: { requestMessageId: requestReply.id } }
        );
      } catch (err) {
        console.warn('[list] Failed to capture request reply message ID:', err.message);
      }
    } catch (err) {
      console.error('[list] ❌ Proposal create/send failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to create approval request: \`${err.message}\``,
      });
    }
  }

  async function handleListRemoveCommand(interaction) {
    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);

    await interaction.deferReply();

    try {
      await connectDB();

      const [blackEntry, whiteEntry] = await Promise.all([
        Blacklist.findOne({
          $or: [{ name }, { allCharacters: name }],
        })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Whitelist.findOne({
          $or: [{ name }, { allCharacters: name }],
        })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
      ]);

      if (!blackEntry && !whiteEntry) {
        await interaction.editReply({
          content: `⚠️ No blacklist/whitelist entry found for **${name}**.`,
        });
        return;
      }

      const removeOne = async (entry, type) => {
        const { model, label, icon } = getListContext(type);

        if (!entry.addedByUserId) {
          return `⚠️ **${entry.name}** in ${label} is a legacy entry without owner metadata, so it cannot be removed with this command.`;
        }

        if (entry.addedByUserId !== interaction.user.id) {
          return `⛔ You cannot remove **${entry.name}** from ${label}. Only **${entry.addedByTag || entry.addedByUserId}** (who added it) can remove it.`;
        }

        await model.deleteOne({ _id: entry._id });
        return `${icon} Removed **${entry.name}** from ${label}.`;
      };

      if (blackEntry && whiteEntry) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('remove_black')
            .setLabel('1. Remove in black list')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId('remove_white')
            .setLabel('2. Remove in white list')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId('remove_both')
            .setLabel('3. Remove both')
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({
          content: `🔎 Found **${name}** in both blacklist and whitelist.\n choose a removal option:`,
          components: [row],
        });

        const reply = await interaction.fetchReply();
        const button = await reply.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => i.user.id === interaction.user.id,
          time: 30000,
        });

        let messages = [];
        if (button.customId === 'remove_black') {
          messages.push(await removeOne(blackEntry, 'black'));
        } else if (button.customId === 'remove_white') {
          messages.push(await removeOne(whiteEntry, 'white'));
        } else {
          messages = await Promise.all([
            removeOne(blackEntry, 'black'),
            removeOne(whiteEntry, 'white'),
          ]);
        }

        await button.update({
          content: messages.join('\n'),
          components: [],
        });
        return;
      }

      if (blackEntry) {
        const message = await removeOne(blackEntry, 'black');
        await interaction.editReply({ content: message });
        return;
      }

      const message = await removeOne(whiteEntry, 'white');
      await interaction.editReply({ content: message });
    } catch (err) {
      console.error('[list] ❌ Remove failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to remove entry: \`${err.message}\``,
      });
    }
  }

  return {
    handleListCheckCommand,
    handleListAddCommand,
    handleListRemoveCommand,
    handleListAddApprovalButton,
  };
}
