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
import { getClassName } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
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
  // '123456789012345678',
];
const SENIOR_APPROVER_ID = '324502048102154241';

function getListContext(type) {
  if (type === 'black') {
    return {
      model: Blacklist,
      label: 'blacklist',
      color: 0xed4245,
      icon: '⛔',
    };
  }

  return {
    model: Whitelist,
    label: 'whitelist',
    color: 0x57f287,
    icon: '✅',
  };
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
    'Read this image and extract only Lost Ark character names that are clearly visible.',
    'Preserve every character exactly as shown in the image, including special letters and diacritics.',
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

  const names = parsed
    .map((item) => (typeof item === 'string' ? normalizeCharacterName(item) : ''))
    .filter(Boolean);

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

    const aiRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30000),
    });

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

function buildListAddApprovalEmbed(guild, payload) {
  const embed = new EmbedBuilder()
    .setTitle('List add approval required')
    .setDescription(`A new list add request was submitted in **${guild.name}**.`)
    .addFields(
      { name: 'Request ID', value: payload.requestId, inline: false },
      { name: 'Type', value: payload.type, inline: true },
      { name: 'Name', value: payload.name, inline: true },
      { name: 'Raid', value: payload.raid || 'N/A', inline: true },
      { name: 'Reason', value: payload.reason, inline: false },
      { name: 'Requested by', value: `${payload.requestedByDisplayName} (<@${payload.requestedByUserId}>)`, inline: false }
    )
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

function buildApprovalResultRow(actionLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_approved_done')
      .setLabel(actionLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

export function createListHandlers({ client }) {
  const pendingListAddApprovals = new Map();

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

    await Promise.all(
      approverIds.map(async (approverId) => {
        try {
          const user = await client.users.fetch(approverId);
          if (!user || user.bot) return;

          await user.send({ embeds: [embed], components: [row] });
          deliveredApproverIds.push(user.id);
        } catch (err) {
          console.warn(`[list] Failed to DM approver ${approverId}:`, err.message);
        }
      })
    );

    if (deliveredApproverIds.length === 0) {
      return { success: false, reason: 'Unable to DM configured approvers. Check user IDs/privacy settings.' };
    }

    return { success: true, deliveredApproverIds };
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

      if (rejected) {
        await channel.send({
          content: `<@${payload.requestedByUserId}> ❌ Your list add request for **${payload.name}** was rejected by Officer.`,
        });
        return;
      }

      await channel.send({
        content: `<@${payload.requestedByUserId}> ${result.content}`,
        embeds: result.embeds ?? [],
      });
    } catch (err) {
      console.warn('[list] Failed to notify requester in origin channel:', err.message);
    }
  }

  async function handleListAddApprovalButton(interaction) {
    const [action, requestId] = interaction.customId.split(':');
    const payload = pendingListAddApprovals.get(requestId);

    if (!payload) {
      await interaction.reply({
        content: '⚠️ This approval request was already processed or has expired.',
        ephemeral: true,
      });
      return;
    }

    if (!payload.approverIds.includes(interaction.user.id)) {
      await interaction.reply({
        content: '⛔ You are not allowed to approve/reject this request.',
        ephemeral: true,
      });
      return;
    }

    pendingListAddApprovals.delete(requestId);

    if (action === 'listadd_reject') {
      await interaction.update({
        content: `❌ Rejected by **${interaction.user.tag}**`,
        components: [buildApprovalResultRow('Rejected')],
      });
      await notifyRequesterAboutDecision(payload, null, true);
      return;
    }

    try {
      const result = await executeListAddToDatabase(payload);
      await interaction.update({
        content: result.ok
          ? `✅ Approved by **${interaction.user.tag}** and executed successfully.`
          : `⚠️ Approved by **${interaction.user.tag}** but execution returned: ${result.content}`,
        components: [buildApprovalResultRow(result.ok ? 'Approved' : 'Processed')],
      });

      await notifyRequesterAboutDecision(payload, result, false);
    } catch (err) {
      await interaction.update({
        content: `⚠️ Approval executed by **${interaction.user.tag}** but failed: \`${err.message}\``,
        components: [buildApprovalResultRow('Failed')],
      });

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
          const [blackEntry, whiteEntry] = await Promise.all([
            Blacklist.findOne({ $or: [{ name }, { allCharacters: name }] })
              .collation({ locale: 'en', strength: 2 })
              .lean(),
            Whitelist.findOne({ $or: [{ name }, { allCharacters: name }] })
              .collation({ locale: 'en', strength: 2 })
              .lean(),
          ]);

          let hasRoster = false;
          if (!blackEntry && !whiteEntry) {
            const rosterResult = await buildRosterCharacters(name);
            hasRoster = rosterResult.hasValidRoster;
          }

          return { name, blackEntry, whiteEntry, hasRoster };
        })
      );

      const lines = results.map((item, idx) => {
        const isBlack = Boolean(item.blackEntry);
        const isWhite = Boolean(item.whiteEntry);
        const blackReason = item.blackEntry?.reason?.trim();
        const whiteReason = item.whiteEntry?.reason?.trim();
        const blackAddedBy = getAddedByDisplay(item.blackEntry);
        const whiteAddedBy = getAddedByDisplay(item.whiteEntry);

        const reasonParts = [];
        if (isBlack) {
          const details = [];
          if (blackReason) details.push(blackReason);
          if (blackAddedBy) details.push(`Added by: **${blackAddedBy}**`);
          if (details.length > 0) {
            reasonParts.push(`black: ${details.join(' — ')}`);
          }
        }
        if (isWhite) {
          const details = [];
          if (whiteReason) details.push(whiteReason);
          if (whiteAddedBy) details.push(`Added by: **${whiteAddedBy}**`);
          if (details.length > 0) {
            reasonParts.push(`white: ${details.join(' — ')}`);
          }
        }

        const reasonSuffix = reasonParts.length > 0 ? ` — ${reasonParts.join(' | ')}` : '';

        let icon = '';
        if (isBlack && isWhite) {
          icon = '⛔✅ ';
        } else if (isBlack) {
          icon = '⛔ ';
        } else if (isWhite) {
          icon = '✅ ';
        } else if (item.hasRoster) {
          icon = '❓ ';
        } else {
          return `${idx + 1}. No roster found: **${item.name}**`;
        }

        return `${idx + 1}. ${icon}**${item.name}**${reasonSuffix}`;
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

      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({
          content: `⚠️ Failed to send approval request to approvers: ${sent.reason}`,
        });
        return;
      }

      pendingListAddApprovals.set(requestId, {
        ...payload,
        approverIds: sent.deliveredApproverIds,
      });

      await interaction.editReply({
        content: `📝 Proposal submitted for approval. Request ID: **${requestId}**`,
      });
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
