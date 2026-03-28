import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import GuildConfig from '../../models/GuildConfig.js';
import PendingApproval from '../../models/PendingApproval.js';
import { getClassName } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
  detectAltsViaStronghold,
} from '../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../services/listCheckService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../utils/names.js';

// Approver IDs loaded from environment variables
const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;
const MEMBER_APPROVER_IDS = config.memberApproverIds;

function getListContext(type) {
  if (type === 'black') {
    return { model: Blacklist, label: 'blacklist', color: 0xed4245, icon: '⛔' };
  }
  if (type === 'watch') {
    return { model: Watchlist, label: 'watchlist', color: 0xfee75c, icon: '⚠️' };
  }
  return { model: Whitelist, label: 'whitelist', color: 0x57f287, icon: '✅' };
}

function buildListAddApprovalEmbed(guild, payload, options = {}) {
  const title = options.title || 'List Add — Approval Required';
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

  for (const id of SENIOR_APPROVER_IDS) {
    if (id && !recipientIds.includes(id)) recipientIds.push(id);
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
  if (SENIOR_APPROVER_IDS.includes(userId)) return true;
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
      return { success: false, reason: 'No approver user IDs configured. Set SENIOR_APPROVER_IDS or OFFICER_APPROVER_IDS in env.' };
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
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const name = normalizeCharacterName(payload.name);

    // Step 1: Check if character exists
    const { hasValidRoster, allCharacters, targetItemLevel } = await buildRosterCharacters(name);
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
          .setTitle('No Roster Found')
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
        content: `❌ No roster found for **${name}**. No similar names found.`,
        embeds: [],
      };
    }

    // Step 2: Check ilvl >= 1700 (using exact ilvl from roster, not regex on HTML)
    if (targetItemLevel !== null && targetItemLevel < 1700) {
      return {
        ok: false,
        content: `❌ **${name}** has item level \`${targetItemLevel.toFixed(2)}\` (below 1700). Cannot add to ${label}.`,
        embeds: [],
      };
    }

    // Step 3: Check if already in list
    await connectDB();

    const existed = await model.findOne({
      $or: [{ name }, { allCharacters: name }],
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    if (existed) {
      const isRosterMatch = existed.name.toLowerCase() !== name.toLowerCase();
      const via = isRosterMatch ? ` (roster match: **${existed.name}** is already in ${label})` : '';
      return {
        ok: false,
        content: `⚠️ **${name}** already exists in ${label}.${via}`,
        embeds: [],
      };
    }

    // Step 4: Create entry
    const entry = await model.create({
      name,
      reason: payload.reason,
      raid: payload.raid,
      logsUrl: payload.logsUrl || '',
      imageUrl: payload.imageUrl,
      allCharacters,
      addedByUserId: payload.requestedByUserId,
      addedByTag: payload.requestedByTag,
      addedByName: payload.requestedByName,
      addedByDisplayName: payload.requestedByDisplayName,
    });

    // Build result embed with character links
    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;
    const autoLogsLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/logs`;

    const linkParts = [`[Roster](${rosterLink})`, `[Logs](${autoLogsLink})`];
    if (payload.logsUrl) linkParts.push(`[Evidence Logs](${payload.logsUrl})`);

    const allCharsDisplay = allCharacters.length <= 6
      ? allCharacters.join(', ')
      : allCharacters.slice(0, 6).join(', ') + ` +${allCharacters.length - 6} more`;

    const embed = new EmbedBuilder()
      .setTitle(`${labelCap} — Entry Added`)
      .addFields(
        { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: payload.reason || 'N/A', inline: true },
        { name: 'Raid', value: payload.raid || 'N/A', inline: true },
        { name: `All Characters (${allCharacters.length})`, value: allCharsDisplay, inline: false },
        { name: 'Links', value: linkParts.join(' · '), inline: false }
      )
      .setColor(color)
      .setTimestamp(new Date());

    if (payload.imageUrl) {
      embed.setImage(payload.imageUrl);
    }

    // Broadcast to all notification channels (fire-and-forget)
    broadcastListChange('added', entry, payload).catch((err) =>
      console.warn('[list] Broadcast failed:', err.message)
    );

    return {
      ok: true,
      content: `${icon} Added **${entry.name}** to ${label}.`,
      embeds: [embed],
    };
  }

  async function broadcastListChange(action, entry, payload) {
    const { label, color, icon } = getListContext(payload.type);
    const addedBy = payload.requestedByDisplayName || payload.requestedByTag || 'Unknown';
    const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;

    // Capitalize label for title (blacklist → Blacklist)
    const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
    const actionCap = action.charAt(0).toUpperCase() + action.slice(1);

    const embed = new EmbedBuilder()
      .setTitle(`📢 ${icon} ${labelCap} — ${actionCap}`)
      .addFields(
        { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
        { name: 'Reason', value: entry.reason || 'N/A', inline: true },
      )
      .setColor(color)
      .setFooter({ text: `By ${addedBy}` })
      .setTimestamp(new Date());

    if (entry.raid) embed.addFields({ name: 'Raid', value: entry.raid, inline: true });
    if (entry.imageUrl) embed.setImage(entry.imageUrl);

    // Collect notification channel IDs from OTHER guilds only
    // Skip the guild where the action originated — user already sees the reply there
    const originGuildId = payload.guildId || '';
    const channelIds = new Set();

    try {
      const guildConfigs = await GuildConfig.find({ listNotifyChannelId: { $ne: '' } }).lean();
      for (const gc of guildConfigs) {
        if (gc.guildId === originGuildId) continue; // skip same server
        channelIds.add(gc.listNotifyChannelId);
      }
    } catch (err) {
      console.warn('[list] Failed to query GuildConfig for broadcast:', err.message);
    }

    // Only use env var channels if NO guild has configured via /lasetup
    if (channelIds.size === 0) {
      for (const id of config.listNotifyChannelIds) {
        channelIds.add(id);
      }
    }

    if (channelIds.size === 0) return;

    await Promise.all(
      [...channelIds].map(async (channelId) => {
        try {
          const channel = await client.channels.fetch(channelId);
          if (channel?.isTextBased()) {
            await channel.send({ embeds: [embed] });
          }
        } catch (err) {
          console.warn(`[list] Failed to broadcast to channel ${channelId}:`, err.message);
        }
      })
    );
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
      names = await extractNamesFromImage(image);
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
      const results = await checkNamesAgainstLists(limitedNames);
      const lines = formatCheckResults(results);

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
    const logs = interaction.options.getString('logs') ?? '';
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
        logsUrl: logs,
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
            title: 'List Add — Proposal Submitted',
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

      const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
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
        Watchlist.findOne({
          $or: [{ name }, { allCharacters: name }],
        })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
      ]);

      // Collect all found entries
      const found = [];
      if (blackEntry) found.push({ entry: blackEntry, type: 'black' });
      if (whiteEntry) found.push({ entry: whiteEntry, type: 'white' });
      if (watchEntry) found.push({ entry: watchEntry, type: 'watch' });

      if (found.length === 0) {
        await interaction.editReply({
          content: `⚠️ No list entry found for **${name}**.`,
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

        broadcastListChange('removed', entry, {
          type,
          guildId: interaction.guild?.id || '',
          requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
          requestedByTag: interaction.user.tag,
        }).catch((err) => console.warn('[list] Broadcast failed:', err.message));

        return `${icon} Removed **${entry.name}** from ${label}.`;
      };

      // Single entry — remove directly
      if (found.length === 1) {
        const message = await removeOne(found[0].entry, found[0].type);
        await interaction.editReply({ content: message });
        return;
      }

      // Multiple entries — show selection buttons
      const buttonStyles = { black: ButtonStyle.Danger, white: ButtonStyle.Success, watch: ButtonStyle.Secondary };
      const row = new ActionRowBuilder().addComponents(
        ...found.map((f, i) => {
          const { label } = getListContext(f.type);
          return new ButtonBuilder()
            .setCustomId(`remove_${f.type}`)
            .setLabel(`${i + 1}. Remove from ${label}`)
            .setStyle(buttonStyles[f.type] || ButtonStyle.Secondary);
        }),
        new ButtonBuilder()
          .setCustomId('remove_all')
          .setLabel(`${found.length + 1}. Remove all`)
          .setStyle(ButtonStyle.Secondary)
      );

      const listNames = found.map((f) => getListContext(f.type).label).join(' and ');
      await interaction.editReply({
        content: `🔎 Found **${name}** in ${listNames}.\nChoose a removal option:`,
        components: [row],
      });

      const reply = await interaction.fetchReply();
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30000,
      });

      let messages;
      if (button.customId === 'remove_all') {
        messages = await Promise.all(found.map((f) => removeOne(f.entry, f.type)));
      } else {
        const target = found.find((f) => button.customId === `remove_${f.type}`);
        messages = target ? [await removeOne(target.entry, target.type)] : ['⚠️ Unknown selection.'];
      }

      await button.update({
        content: messages.join('\n'),
        components: [],
      });
      return;
    } catch (err) {
      console.error('[list] ❌ Remove failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed to remove entry: \`${err.message}\``,
      });
    }
  }

  async function handleListViewCommand(interaction) {
    const type = interaction.options.getString('type', true);
    const ITEMS_PER_PAGE = 10;

    await interaction.deferReply();

    try {
      await connectDB();

      const types = type === 'all' ? ['black', 'white', 'watch'] : [type];
      const allEntries = [];

      for (const t of types) {
        const { model, label, color, icon } = getListContext(t);
        const entries = await model.find({}).sort({ addedAt: -1 }).lean();
        for (const e of entries) {
          allEntries.push({ ...e, _listType: t, _label: label, _color: color, _icon: icon });
        }
      }

      if (allEntries.length === 0) {
        await interaction.editReply({ content: type === 'all' ? 'All lists are empty.' : `${getListContext(type).icon} ${getListContext(type).label} is empty.` });
        return;
      }

      // Sort all entries by addedAt (newest first)
      allEntries.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

      const totalPages = Math.ceil(allEntries.length / ITEMS_PER_PAGE);
      let currentPage = 0;

      function buildPage(page) {
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);

        const lines = pageEntries.map((e, i) => {
          const parts = [`${e._icon} **${e.name}**`];
          if (e.reason) parts.push(e.reason);
          if (e.raid) parts.push(`[${e.raid}]`);
          const date = e.addedAt ? `<t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>` : '';
          if (date) parts.push(date);
          if (e.imageUrl) parts.push('📎');
          return `${start + i + 1}. ${parts.join(' — ')}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(type === 'all' ? `All Lists (${allEntries.length})` : `${getListContext(type).icon} ${getListContext(type).label} (${allEntries.length})`)
          .setDescription(lines.join('\n'))
          .setColor(type === 'all' ? 0x5865f2 : getListContext(type).color)
          .setFooter({ text: `Page ${page + 1}/${totalPages}` })
          .setTimestamp();

        return embed;
      }

      function buildComponents(page) {
        const rows = [];

        // Navigation buttons
        const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('listview_prev')
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('listview_next')
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),
        );
        rows.push(navRow);

        // Evidence dropdown for entries with images on current page
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);
        const withImages = pageEntries.filter((e) => e.imageUrl);

        if (withImages.length > 0) {
          const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('listview_evidence')
              .setPlaceholder('📎 View evidence for...')
              .addOptions(
                withImages.slice(0, 25).map((e, i) => ({
                  label: e.name,
                  description: (e.reason || 'No reason').slice(0, 100),
                  value: String(start + pageEntries.indexOf(e)),
                  emoji: e._icon,
                }))
              )
          );
          rows.push(selectRow);
        }

        return rows;
      }

      const components = buildComponents(0);

      await interaction.editReply({
        embeds: [buildPage(0)],
        components,
      });


      const reply = await interaction.fetchReply();
      const collector = reply.createMessageComponentCollector({
        time: 300000,
      });

      collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i.reply({ content: '⛔ Only the command user can navigate.', ephemeral: true });
          return;
        }

        if (i.customId === 'listview_prev') {
          currentPage = Math.max(0, currentPage - 1);
          await i.update({ embeds: [buildPage(currentPage)], components: buildComponents(currentPage) });
        } else if (i.customId === 'listview_next') {
          currentPage = Math.min(totalPages - 1, currentPage + 1);
          await i.update({ embeds: [buildPage(currentPage)], components: buildComponents(currentPage) });
        } else if (i.customId === 'listview_evidence') {
          const idx = parseInt(i.values[0]);
          const entry = allEntries[idx];

          if (!entry?.imageUrl) {
            await i.reply({ content: 'No evidence image for this entry.', ephemeral: true });
            return;
          }

          const embed = new EmbedBuilder()
            .setTitle(`${entry._icon} ${entry.name}`)
            .addFields(
              { name: 'Reason', value: entry.reason || 'N/A', inline: true },
              { name: 'Raid', value: entry.raid || 'N/A', inline: true },
              { name: 'List', value: entry._label, inline: true },
            )
            .setImage(entry.imageUrl)
            .setColor(entry._color)
            .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

          if (entry.logsUrl) {
            embed.addFields({ name: 'Logs', value: `[View Logs](${entry.logsUrl})`, inline: false });
          }

          await i.reply({ embeds: [embed], ephemeral: true });
        }
      });

      collector.on('end', async () => {
        const disabledNav = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('listview_prev_disabled').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('listview_next_disabled').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        await interaction.editReply({
          content: '⏱️ Session expired. Use `/list view` again to browse.',
          components: [disabledNav],
        }).catch(() => {});
      });
    } catch (err) {
      console.error(`[list] View failed:`, err.message);
      await interaction.editReply({ content: `⚠️ Failed to load list: \`${err.message}\`` });
    }
  }

  async function handleQuickAddSelect(interaction) {
    const name = interaction.values[0];

    const modal = new ModalBuilder()
      .setCustomId(`quickadd_modal:${name}`)
      .setTitle(`Quick Add — ${name}`)
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_type')
            .setLabel('Type (black / watch)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('black')
            .setValue('black')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_reason')
            .setLabel('Reason')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Why add this player?')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('quickadd_raid')
            .setLabel('Raid (optional)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. Kazeros Hard')
            .setRequired(false)
        ),
      );

    await interaction.showModal(modal);
  }

  async function handleQuickAddModal(interaction) {
    const name = interaction.customId.split(':')[1];
    let type = interaction.fields.getTextInputValue('quickadd_type').trim().toLowerCase();
    const reason = interaction.fields.getTextInputValue('quickadd_reason').trim();
    const raid = interaction.fields.getTextInputValue('quickadd_raid')?.trim() || '';

    // Validate type
    if (!['black', 'white', 'watch'].includes(type)) type = 'black';

    await interaction.deferReply({ ephemeral: true });

    if (!reason) {
      await interaction.editReply({ content: '❌ Reason cannot be empty.' });
      return;
    }

    try {
      const payload = {
        requestId: randomUUID(),
        guildId: interaction.guild?.id || '',
        channelId: interaction.channelId,
        type,
        name,
        reason,
        raid,
        logsUrl: '',
        imageUrl: '',
        requestedByUserId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedByName: interaction.user.username,
        requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
        createdAt: Date.now(),
      };

      if (isRequesterAutoApprover(payload.requestedByUserId)) {
        const result = await executeListAddToDatabase(payload);
        await interaction.editReply({
          content: result.content,
          embeds: result.embeds ?? [],
        });
        return;
      }

      // Non-approver → send approval request
      const sent = await sendListAddApprovalToApprovers(interaction.guild, payload);
      if (!sent.success) {
        await interaction.editReply({ content: `⚠️ ${sent.reason}` });
        return;
      }

      await connectDB();
      await PendingApproval.create({
        ...payload,
        approverIds: sent.deliveredApproverIds,
        approverDmMessages: sent.deliveredDmMessages,
      });

      await interaction.editReply({
        content: `📨 Approval request sent for **${name}** → ${type}list.`,
      });
    } catch (err) {
      console.error('[quickadd] Failed:', err.message);
      await interaction.editReply({
        content: `⚠️ Failed: \`${err.message}\``,
      });
    }
  }

  return {
    handleListCheckCommand,
    handleListAddCommand,
    handleListRemoveCommand,
    handleListViewCommand,
    handleListAddApprovalButton,
    handleQuickAddSelect,
    handleQuickAddModal,
  };
}
