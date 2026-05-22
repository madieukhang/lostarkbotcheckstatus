/**
 * helpers.js
 * Pure helpers shared across the /la-list * command handlers. None of these
 * functions close over the Discord client, so they live outside the
 * createListHandlers factory.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { COLORS, ICONS } from '../../utils/ui.js';
import { renderTrackedAltsField } from './trackedAltsRender.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;
const MEMBER_APPROVER_IDS = config.memberApproverIds;

export function getListContext(type) {
  if (type === 'black') {
    return { model: Blacklist, label: 'blacklist', color: COLORS.danger, icon: '⛔' };
  }
  if (type === 'watch') {
    return { model: Watchlist, label: 'watchlist', color: COLORS.warning, icon: '⚠️' };
  }
  return { model: Whitelist, label: 'whitelist', color: COLORS.success, icon: '✅' };
}

/**
 * Tack the visual tokens onto a list-entry document so it can flow into
 * `buildEvidenceEmbed` (and any other renderer that reads `_icon` /
 * `_label` / `_color`). Replaces the `{ ...entry, _icon: ctx.icon, ...}`
 * one-liner that was sprawled across /la-evidence, /la-search,
 * /la-check, /la-roster, and the approval-flow evidence button. Returns
 * a shallow clone so the caller's input doc isn't mutated.
 */
export function decorateListEntry(entry, listType) {
  const ctx = getListContext(listType);
  return {
    ...entry,
    _listType: listType,
    _icon: ctx.icon,
    _label: ctx.label,
    _color: ctx.color,
  };
}

/**
 * Mongo ObjectId regex · used by every `<type>:<_id>` autocomplete /
 * select-menu value encoding the bot ships (/la-evidence picker,
 * /la-check evidence dropdown). Centralised so the shape can evolve
 * (length tweak, separator change) in one place instead of three.
 */
export const LIST_ENTRY_ID_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Parse the canonical `<listType>:<_id>` value encoding used by every
 * dropdown / autocomplete the bot ships for list entries. Returns
 * `{ listType, id }` on a valid match (listType in {black, white,
 * watch} and id passes the Mongo ObjectId shape) or `null` otherwise.
 * Callers that also accept free-typed names should fall through to
 * a name-based lookup when this returns null.
 */
export function parseListEntryRef(raw) {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  if (idx <= 0 || idx >= raw.length - 1) return null;
  const listType = raw.slice(0, idx);
  if (listType !== 'black' && listType !== 'white' && listType !== 'watch') return null;
  const id = raw.slice(idx + 1).trim();
  if (!LIST_ENTRY_ID_RE.test(id)) return null;
  return { listType, id };
}

/**
 * Build a standardized embed for trusted user block messages.
 * Wraps the shared buildAlertEmbed with severity:'trusted' so trusted
 * blocks have consistent styling with the rest of the bot's alerts.
 */
export function buildTrustedBlockEmbed(name, reason, { via } = {}) {
  const rosterLink = rosterUrl(name);
  const description = via
    ? `**${name}** shares a roster with trusted user **${via}** and cannot be added to any list.`
    : `**${name}** is a trusted user and cannot be added to any list.`;

  return buildAlertEmbed({
    severity: AlertSeverity.TRUSTED,
    title: 'Trusted User · Blocked',
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
  const rosterLink = rosterUrl(entry.name);

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

  const embed = buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon: `${ICONS.edit} ${icon}`,
    color,
    title: `${labelCap}${scopeTag} · ${titleAction}`,
    fields,
    footer: requesterDisplayName ? `Edited by ${requesterDisplayName}` : undefined,
  });

  if (freshDisplayUrl) {
    embed.setImage(freshDisplayUrl);
  }

  return embed;
}

/**
 * Approval-DM card sent to senior + officer approvers when a non-bypass
 * member submits a /la-list add (or /la-list edit). Approvers review
 * many of these per day; the layout is optimised for fast scan:
 *
 *   - Title bar: shield icon + action verb + entry name
 *   - Hero line: who/where/which list + scope tag (`[Local]`/`[Global]`)
 *   - Inline meta (3-up): Type · Raid · Scope
 *   - Reason: full-width field, capped at 1024
 *   - Tracked alts: linked roster names so the approver can verify
 *     the request maps to the right account in one click
 *   - Requested by: full-width with mention so approvers can ping back
 *   - Request ID: full-width footer bar (also feeds the Approve button
 *     dispatch path so it must remain in the embed for audit trail)
 *
 * The list-type icon (⛔/✅/⚠️) is preferred over the generic shield
 * because approvers triage at a glance: a red ⛔ DM lands differently
 * from a green ✅ one even before they read the title.
 */
export function buildListAddApprovalEmbed(guild, payload, options = {}) {
  const includeRequestedBy = options.includeRequestedBy ?? true;
  const isEdit = payload.action === 'edit';

  // List-type vocabulary derived locally so we don't import the full
  // getListContext (which lives below this fn and would create a cycle).
  let listIcon = '🛡️';
  let listLabel = 'list';
  let listColor = COLORS.info;
  if (payload.type === 'black') { listIcon = '⛔'; listLabel = 'blacklist'; listColor = COLORS.danger; }
  else if (payload.type === 'white') { listIcon = '✅'; listLabel = 'whitelist'; listColor = COLORS.success; }
  else if (payload.type === 'watch') { listIcon = '⚠️'; listLabel = 'watchlist'; listColor = COLORS.warning; }

  const titleVerb = isEdit ? 'Edit' : 'Add';
  const title = options.title || `${listIcon} ${titleVerb} approval · ${payload.name}`;
  const scopeTag = payload.scope === 'server' ? ' `[Local]`' : payload.scope === 'global' ? ' `[Global]`' : '';

  const heroLine = isEdit
    ? `An officer in **${guild.name}** wants to **edit** **${payload.name}** on the ${listLabel}${scopeTag}.`
    : `An officer in **${guild.name}** wants to **add** **${payload.name}** to the ${listLabel}${scopeTag}.`;

  const fields = [
    { name: '📒 List', value: `${listIcon} ${listLabel}`, inline: true },
    { name: '🗡️ Raid', value: payload.raid ? `\`${payload.raid}\`` : 'N/A', inline: true },
    { name: '🌐 Scope', value: payload.scope || 'global', inline: true },
    { name: '📝 Reason', value: (payload.reason || 'N/A').slice(0, 1024), inline: false },
  ];

  // Tracked alts give the approver "is this the right person?" context
  // without forcing them to run /la-roster manually. Routed through the
  // shared renderer so this card stays visually identical to the broadcast
  // / la-list view evidence detail (numbering, link, overflow tail).
  // No statMap supplied · the approval-DM doesn't run a snapshot lookup,
  // so rows degrade to plain `[name](link)` rather than class+ilvl+CP.
  const altsField = renderTrackedAltsField({
    names: payload.allCharacters,
    primaryName: payload.name,
  });
  if (altsField) fields.push(altsField);

  if (includeRequestedBy) {
    fields.push({
      name: '👤 Requested by',
      value: `${payload.requestedByDisplayName} (<@${payload.requestedByUserId}>)`,
      inline: false,
    });
  }

  // Request ID stays at the bottom · approvers shouldn't scan past it
  // to read business context. Code-formatted so it's visually distinct
  // and copy-paste-friendly when an approver wants to look the row
  // up server-side.
  fields.push({
    name: '🆔 Request ID',
    value: `\`${payload.requestId}\``,
    inline: false,
  });

  // No titleIcon override · the title already leads with the list icon
  // (⛔/✅/⚠️). Stacking the shield prefix on top reads cluttered ("🛡️ ⛔
  // Add approval"). The shield emoji is reintroduced subtly via the
  // approver-flow footer instead.
  const embed = buildAlertEmbed({
    severity: AlertSeverity.INFO,
    titleIcon: '',
    color: listColor,
    title,
    description: heroLine,
    fields,
    footer: `${ICONS.shield} Approve / Reject buttons below · Lost Ark Check approval flow`,
  });

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
