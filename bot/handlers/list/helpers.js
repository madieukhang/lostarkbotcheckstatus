/**
 * helpers.js
 * Pure helpers shared across the /list * command handlers. None of these
 * functions close over the Discord client, so they live outside the
 * createListHandlers factory.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;
const MEMBER_APPROVER_IDS = config.memberApproverIds;

export function getListContext(type) {
  if (type === 'black') {
    return { model: Blacklist, label: 'blacklist', color: 0xed4245, icon: '⛔' };
  }
  if (type === 'watch') {
    return { model: Watchlist, label: 'watchlist', color: 0xfee75c, icon: '⚠️' };
  }
  return { model: Whitelist, label: 'whitelist', color: 0x57f287, icon: '✅' };
}

/**
 * Build a standardized embed for trusted user block messages.
 * Wraps the shared buildAlertEmbed with severity:'trusted' so trusted
 * blocks have consistent styling with the rest of the bot's alerts.
 */
export function buildTrustedBlockEmbed(name, reason, { via } = {}) {
  const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
  const description = via
    ? `**${name}** shares a roster with trusted user **${via}** and cannot be added to any list.`
    : `**${name}** is a trusted user and cannot be added to any list.`;

  return buildAlertEmbed({
    severity: AlertSeverity.TRUSTED,
    title: 'Trusted User — Blocked',
    description,
    fields: [
      { name: 'Name', value: `[${name}](${rosterLink})`, inline: true },
      { name: 'Trust reason', value: reason || 'N/A', inline: true },
    ],
  });
}

/**
 * Build a rich success embed for /la-list edit (both auto-approve and approval
 * paths). Replaces the old plain-text "✅ Name edited in blacklist" reply
 * with a color-coded, structured response showing the entry's current state,
 * the changes applied, and (when available) the fresh evidence image.
 */
export function buildListEditSuccessEmbed(entry, options = {}) {
  const { changes = [], type, freshDisplayUrl, requesterDisplayName, isMove = false } = options;
  const { color, label, icon } = getListContext(type);
  const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
  const scopeTag = entry.scope === 'server' ? ' (Local)' : '';
  const titleAction = isMove ? 'Edited & Moved' : 'Edited';
  const rosterLink = `https://lostark.bible/character/NA/${encodeURIComponent(entry.name)}/roster`;

  const fields = [
    { name: 'Name', value: `[${entry.name}](${rosterLink})`, inline: true },
    { name: 'Reason', value: entry.reason || 'N/A', inline: true },
  ];
  if (entry.raid) {
    fields.push({ name: 'Raid', value: entry.raid, inline: true });
  }
  if (changes.length > 0) {
    const changesText = changes.map((c) => `• ${c}`).join('\n');
    fields.push({
      name: `Changes (${changes.length})`,
      value: changesText.length > 1024 ? changesText.slice(0, 1020) + '…' : changesText,
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`✏️ ${icon} ${labelCap}${scopeTag} — ${titleAction}`)
    .addFields(fields)
    .setColor(color)
    .setTimestamp(new Date());

  if (requesterDisplayName) {
    embed.setFooter({ text: `Edited by ${requesterDisplayName}` });
  }
  if (freshDisplayUrl) {
    embed.setImage(freshDisplayUrl);
  }

  return embed;
}

export function buildListAddApprovalEmbed(guild, payload, options = {}) {
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
    .setDescription(payload.action === 'edit'
      ? `A list edit request was submitted in **${guild.name}**.`
      : `A new list add request was submitted in **${guild.name}**.`)
    .addFields(fields)
    .setColor(payload.type === 'black' ? 0xed4245 : 0x57f287)
    .setTimestamp(new Date());

  if (payload.imageUrl) {
    embed.setImage(payload.imageUrl);
  }

  return embed;
}

export function getApproverRecipientIds() {
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

export function isRequesterAutoApprover(userId) {
  if (!userId) return false;
  if (SENIOR_APPROVER_IDS.includes(userId)) return true;
  if (OFFICER_APPROVER_IDS.includes(userId)) return true;
  return MEMBER_APPROVER_IDS.includes(userId);
}

/**
 * Stricter variant used by /la-list multiadd auto-approve check.
 * Only senior + officer can bypass bulk approval; MEMBER_APPROVER_IDS
 * (which gives bypass rights on single /la-list add for legacy reasons)
 * does NOT confer bulk-add auto-approval. This matches the README claim
 * that only officers/seniors auto-approve multiadd batches.
 */
export function isOfficerOrSenior(userId) {
  if (!userId) return false;
  if (SENIOR_APPROVER_IDS.includes(userId)) return true;
  return OFFICER_APPROVER_IDS.includes(userId);
}

/**
 * Senior-only recipient list for /la-list multiadd bulk approval DMs.
 * Unlike getApproverRecipientIds (which mixes in a random officer), this
 * returns exclusively SENIOR_APPROVER_IDS - bulk batches are a high-impact
 * operation that should always be reviewed by a Senior.
 */
export function getSeniorApproverIds() {
  const seen = new Set();
  const out = [];
  for (const id of SENIOR_APPROVER_IDS) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function buildApprovalResultRow(actionLabel) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('listadd_approved_done')
      .setLabel(actionLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
  );
}

export function buildApprovalProcessingRow(action) {
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
