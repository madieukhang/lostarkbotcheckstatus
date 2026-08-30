/**
 * handlers/list/add/editApproval.js
 * Handles the "approve + edit" path off the approval-button flow: an
 * approver opens a modal, rewrites the request's reason/raid/scope,
 * and submits · this module rewrites the PendingApproval doc, runs
 * the same add-to-DB executor as a plain approve, syncs approver DM
 * messages, notifies the requester, and broadcasts the change.
 */

import PendingApproval from '../../../models/PendingApproval.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { buildAlertEmbed, buildNoticeEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { editPayload } from '../../../utils/interactionReplies.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { t } from '../../../services/i18n/index.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildApprovalResultRow,
} from '../helpers.js';

function buildApprovalAlertPayload({ embed, status, lang }) {
  return {
    content: '',
    embeds: [embed],
    components: [buildApprovalResultRow(status, lang)],
  };
}

async function closeApprovalWithAlert({
  interaction,
  requestId,
  embed,
  status = 'Failed',
  lang,
}) {
  await PendingApproval.deleteOne({ requestId });
  await editPayload(interaction, buildApprovalAlertPayload({ embed, status, lang }));
}

function buildLocalizedAlert(key, lang, values = {}) {
  return buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    ...t(key, lang, values),
    lang,
  });
}

export function resolveApprovalMoveImageFields(payload, existingEntry) {
  const imageMessageId = payload.imageMessageId || existingEntry.imageMessageId || '';
  return {
    imageUrl: imageMessageId ? '' : (payload.imageUrl || existingEntry.imageUrl || ''),
    imageMessageId,
    imageChannelId: payload.imageChannelId || existingEntry.imageChannelId || '',
  };
}

function resolveApprovalMoveScope(payload, existingEntry) {
  if (payload.type !== 'black') return {};
  const scope = payload.scope || existingEntry.scope || 'global';
  return { scope, guildId: scope === 'server' ? (payload.guildId || '') : '' };
}

export function buildApprovalMoveData(payload, existingEntry) {
  return {
    name: existingEntry.name,
    reason: payload.reason || existingEntry.reason,
    raid: payload.raid || existingEntry.raid,
    logsUrl: payload.logsUrl || existingEntry.logsUrl,
    ...resolveApprovalMoveImageFields(payload, existingEntry),
    allCharacters: existingEntry.allCharacters || [],
    enrichmentSource: existingEntry.enrichmentSource ?? null,
    enrichedAt: existingEntry.enrichedAt ?? null,
    addedByUserId: existingEntry.addedByUserId,
    addedByTag: existingEntry.addedByTag,
    addedByDisplayName: existingEntry.addedByDisplayName,
    addedAt: existingEntry.addedAt,
    ...resolveApprovalMoveScope(payload, existingEntry),
  };
}

async function rejectBlockedTypeChange({
  interaction,
  payload,
  requestId,
  existingEntry,
  newModel,
  lang,
}) {
  const nameMatch = {
    $or: [{ name: existingEntry.name }, { allCharacters: existingEntry.name }],
  };
  const targetDupe = await newModel.findOne(buildScopedListQuery(
    payload.type,
    nameMatch,
    payload.guildId || '',
    { ownerSeesAll: false, includeEmptyServerScope: true }
  )).collation({ locale: 'en', strength: 2 }).lean();

  if (targetDupe) {
    await closeApprovalWithAlert({
      interaction,
      requestId,
      embed: buildLocalizedAlert(
        'dialogue.listEdit.moveBlocked',
        lang,
        { name: existingEntry.name }
      ),
      lang,
    });
    return true;
  }

  const trustedNow = await TrustedUser.findOne(buildNameRosterQuery([
    existingEntry.name,
    ...(existingEntry.allCharacters || []),
  ])).collation({ locale: 'en', strength: 2 }).lean();
  if (!trustedNow) return false;

  await closeApprovalWithAlert({
    interaction,
    requestId,
    embed: buildTrustedBlockEmbed(existingEntry.name, trustedNow.reason, { lang }),
    status: 'Blocked',
    lang,
  });
  return true;
}

async function applyApprovedTypeChange(args) {
  if (await rejectBlockedTypeChange(args)) return false;
  await args.newModel.create(buildApprovalMoveData(args.payload, args.existingEntry));
  await args.oldModel.deleteOne({ _id: args.existingEntry._id });
  return true;
}

function resolveApprovalTextUpdates(payload, existingEntry) {
  return {
    ...(payload.reason && payload.reason !== existingEntry.reason
      ? { reason: payload.reason }
      : {}),
    ...(payload.raid && payload.raid !== existingEntry.raid
      ? { raid: payload.raid }
      : {}),
    ...(payload.logsUrl && payload.logsUrl !== existingEntry.logsUrl
      ? { logsUrl: payload.logsUrl }
      : {}),
  };
}

function resolveApprovalImageUpdates(payload, existingEntry) {
  if (payload.imageMessageId && payload.imageMessageId !== existingEntry.imageMessageId) {
    return {
      imageUrl: '',
      imageMessageId: payload.imageMessageId,
      imageChannelId: payload.imageChannelId || '',
    };
  }
  if (payload.imageUrl && !payload.imageMessageId && payload.imageUrl !== existingEntry.imageUrl) {
    return {
      imageUrl: payload.imageUrl,
      imageMessageId: '',
      imageChannelId: '',
    };
  }
  return {};
}

function resolveApprovalScopeUpdates(payload, existingEntry) {
  const currentScope = existingEntry.scope || 'global';
  if (payload.type !== 'black' || !payload.scope || payload.scope === currentScope) return {};
  return {
    scope: payload.scope,
    guildId: payload.scope === 'server' ? (payload.guildId || '') : '',
  };
}

export function buildApprovalUpdateFields(payload, existingEntry) {
  return {
    ...resolveApprovalTextUpdates(payload, existingEntry),
    ...resolveApprovalImageUpdates(payload, existingEntry),
    ...resolveApprovalScopeUpdates(payload, existingEntry),
  };
}

async function applyApprovedInPlaceUpdate(args) {
  const updateFields = buildApprovalUpdateFields(args.payload, args.existingEntry);
  if (Object.keys(updateFields).length === 0) return true;
  try {
    await args.oldModel.updateOne(
      { _id: args.existingEntry._id },
      { $set: updateFields }
    );
    return true;
  } catch (err) {
    if (err.code !== 11000 || !updateFields.scope) throw err;
    await closeApprovalWithAlert({
      interaction: args.interaction,
      requestId: args.requestId,
      embed: buildLocalizedAlert('dialogue.listEdit.scopeRaced', args.lang),
      lang: args.lang,
    });
    return false;
  }
}

function broadcastApprovedEdit({ payload, existingEntry, broadcastListChange }) {
  const scope = payload.scope || existingEntry.scope || 'global';
  broadcastListChange('edited', {
    ...(existingEntry.toObject?.() || existingEntry),
    reason: payload.reason || existingEntry.reason,
    raid: payload.raid || existingEntry.raid,
    scope,
  }, {
    type: payload.type,
    guildId: payload.guildId,
    requestedByDisplayName: payload.requestedByDisplayName,
    requestedByTag: payload.requestedByTag,
  }, { onlyOwner: scope === 'server' }).catch(() => {});
}

function buildApprovedPayload(interaction, targetLang) {
  return {
    content: null,
    embeds: [buildNoticeEmbed(
      t('dialogue.listEdit.approvedBy', targetLang, { user: interaction.user.tag }),
      { severity: AlertSeverity.SUCCESS, lang: targetLang }
    )],
    components: [buildApprovalResultRow('Approved', targetLang)],
  };
}

async function finishApprovedEdit({
  interaction,
  payload,
  requestId,
  syncApproverDmMessages,
  notifyRequesterAboutDecision,
  lang,
}) {
  await PendingApproval.deleteOne({ requestId });
  await editPayload(interaction, buildApprovedPayload(interaction, lang));
  await syncApproverDmMessages(
    payload,
    (targetLang) => buildApprovedPayload(interaction, targetLang),
    { excludeMessageId: interaction.message.id }
  );
  await notifyRequesterAboutDecision(payload, { ok: true }, false);
}

/**
 * Process an approver's "edit then approve" submission for a pending
 * /la-list add request. Rewrites the PendingApproval payload, runs the
 * add executor, fans out the result to every approver DM, notifies the
 * requester, and broadcasts the change to the per-guild notify channel.
 *
 * @param {object} args
 * @param {import('discord.js').Client} args.client - Discord client
 * @param {import('discord.js').Interaction} args.interaction - the
 *   modal-submit interaction from the approver
 * @param {object} args.payload - the rewritten add payload (name,
 *   reason, raid, scope, image, allCharacters, …) replacing the doc's
 *   original payload
 * @param {string} args.requestId - PendingApproval document _id
 * @param {Function} args.syncApproverDmMessages - approver DM sync
 * @param {Function} args.broadcastListChange - guild broadcast
 * @param {Function} args.notifyRequesterAboutDecision - requester DM
 * @returns {Promise<void>}
 */
export async function handleApprovedEditRequest({
  interaction,
  payload,
  requestId,
  syncApproverDmMessages,
  broadcastListChange,
  notifyRequesterAboutDecision,
  lang = 'en',
}) {
  const { model: oldModel } = getListContext(payload.currentType || payload.type);
  const { model: newModel } = getListContext(payload.type);
  const existingEntry = await oldModel.findById(payload.existingEntryId);
  if (!existingEntry) {
    await closeApprovalWithAlert({
      interaction,
      requestId,
      embed: buildLocalizedAlert('dialogue.listEdit.originalMissing', lang),
      lang,
    });
    return;
  }

  const args = { interaction, payload, requestId, existingEntry, oldModel, newModel, lang };
  const isTypeChange = payload.currentType && payload.currentType !== payload.type;
  const applied = isTypeChange
    ? await applyApprovedTypeChange(args)
    : await applyApprovedInPlaceUpdate(args);
  if (!applied) return;

  broadcastApprovedEdit({ payload, existingEntry, broadcastListChange });
  await finishApprovedEdit({
    interaction,
    payload,
    requestId,
    syncApproverDmMessages,
    notifyRequesterAboutDecision,
    lang,
  });
}
