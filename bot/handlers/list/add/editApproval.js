/**
 * handlers/list/add/editApproval.js
 * Apply an approved edit to an existing list entry, including transactional
 * cross-list moves, then update approvers and notify the requester.
 */

import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { editPayload } from '../../../utils/interactionReplies.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { normalizeNameList } from '../../../utils/names.js';
import { t } from '../../../services/i18n/index.js';
import { findTrustedEditConflict } from '../edit/trustedGuard.js';
import { moveListEntry } from '../services/moveEntry.js';
import { carryNotesWithEdit, planLatestNoteEdit } from '../notes/entryNotes.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildApprovalResultRow,
  buildDecidedApprovalPayload,
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
  embed,
  status = 'Failed',
  lang,
  completeApproval,
}) {
  await completeApproval();
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
  if (payload.imageUrl && !payload.imageMessageId) {
    return { imageUrl: payload.imageUrl, imageMessageId: '', imageChannelId: '' };
  }
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
    allCharacters: normalizeNameList([
      ...(existingEntry.allCharacters || []),
      ...(payload.additionalNames || []),
    ]),
    enrichmentSource: existingEntry.enrichmentSource ?? null,
    enrichedAt: existingEntry.enrichedAt ?? null,
    addedByUserId: existingEntry.addedByUserId,
    addedByTag: existingEntry.addedByTag,
    addedByDisplayName: existingEntry.addedByDisplayName,
    addedAt: existingEntry.addedAt,
    notes: carryNotesWithEdit(existingEntry, { reason: payload.reason, raid: payload.raid }),
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
  completeApproval,
}) {
  const nameMatch = {
    $or: [{ name: existingEntry.name }, { allCharacters: existingEntry.name }],
  };
  const targetDupe = await newModel.findOne(buildScopedListQuery(
    payload.type,
    nameMatch,
    payload.guildId || '',
    { ownerSeesAll: false, includeEmptyServerScope: true }
  )).collation(CASE_INSENSITIVE_COLLATION).lean();

  if (targetDupe) {
    await closeApprovalWithAlert({
      interaction,
      completeApproval,
      embed: buildLocalizedAlert(
        'dialogue.listEdit.moveBlocked',
        lang,
        { name: existingEntry.name }
      ),
      lang,
    });
    return true;
  }

  return false;
}

async function applyApprovedTypeChange(args) {
  if (await rejectBlockedTypeChange(args)) return false;
  await moveListEntry({
    oldModel: args.oldModel, newModel: args.newModel, existing: args.existingEntry,
    buildData: source => buildApprovalMoveData(args.payload, source), beforeWrite: args.beforeWrite,
  });
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
  const additionalNames = normalizeNameList(args.payload.additionalNames || []);
  if (Object.keys(updateFields).length === 0 && additionalNames.length === 0) return true;
  const noteEdit = planLatestNoteEdit(args.existingEntry, { reason: updateFields.reason, raid: updateFields.raid });
  try {
    await args.beforeWrite();
    const write = await args.oldModel.updateOne(
      { _id: args.existingEntry._id, ...noteEdit.filter },
      {
        $set: { ...updateFields, ...noteEdit.set },
        ...(additionalNames.length > 0
          ? { $addToSet: { allCharacters: { $each: additionalNames } } }
          : {}),
      }
    );
    if (write.matchedCount !== 1) {
      const stillListed = await args.oldModel.exists({ _id: args.existingEntry._id });
      await closeApprovalWithAlert({
        interaction: args.interaction,
        completeApproval: args.completeApproval,
        embed: buildLocalizedAlert(`dialogue.listEdit.${stillListed ? 'entryChanged' : 'originalMissing'}`, args.lang),
        lang: args.lang,
      });
      return false;
    }
    return true;
  } catch (err) {
    if (err.code !== 11000 || !updateFields.scope) throw err;
    await closeApprovalWithAlert({
      interaction: args.interaction,
      completeApproval: args.completeApproval,
      embed: buildLocalizedAlert('dialogue.listEdit.scopeRaced', args.lang),
      lang: args.lang,
    });
    return false;
  }
}

// The broadcast compares the entry as saved with the one read before the
// write, so it carries the same text and evidence updates the write applied.
function broadcastApprovedEdit({ payload, existingEntry, broadcastListChange }) {
  const scope = payload.scope || existingEntry.scope || 'global';
  const previousEntry = existingEntry.toObject?.() || existingEntry;
  broadcastListChange('edited', {
    ...previousEntry,
    ...buildApprovalUpdateFields(payload, existingEntry),
    scope,
    allCharacters: normalizeNameList([
      ...(existingEntry.allCharacters || []),
      ...(payload.additionalNames || []),
    ]),
  }, {
    type: payload.type,
    guildId: payload.guildId,
    requestedByDisplayName: payload.requestedByDisplayName,
    requestedByTag: payload.requestedByTag,
  }, {
    onlyOwner: scope === 'server',
    previousEntry,
    previousType: payload.currentType || payload.type,
  }).catch((err) => console.warn('[list] Broadcast failed:', err.message));
}

function buildApprovedPayload(interaction, payload, targetLang) {
  return buildDecidedApprovalPayload({
    client: interaction.client,
    payload,
    outcome: 'editApproved',
    approver: interaction.user.tag,
    lang: targetLang,
  });
}

async function finishApprovedEdit({
  interaction,
  payload,
  syncApproverDmMessages,
  notifyRequesterAboutDecision,
  lang,
  completeApproval,
}) {
  await completeApproval();
  await editPayload(interaction, buildApprovedPayload(interaction, payload, lang));
  await syncApproverDmMessages(
    payload,
    (targetLang) => buildApprovedPayload(interaction, payload, targetLang),
    { excludeMessageId: interaction.message.id }
  );
  await notifyRequesterAboutDecision(payload, { ok: true }, false);
}

/**
 * Apply a saved /la-list edit request after the decision handler claims it.
 * Recheck Trusted protection before updating or moving the existing entry.
 *
 * @param {object} args
 * @param {import('discord.js').Interaction} args.interaction - the
 *   approver's acknowledged button interaction
 * @param {object} args.payload - saved edit fields and source entry identity
 * @param {string} args.requestId - PendingApproval request identifier
 * @param {Function} args.syncApproverDmMessages - approver DM sync
 * @param {Function} args.broadcastListChange - guild broadcast
 * @param {Function} args.notifyRequesterAboutDecision - requester DM
 * @param {Function} args.completeApproval - finalize the current approval lease
 * @param {Function} args.beforeWrite - verify lease ownership before each write
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
  completeApproval,
  beforeWrite,
}) {
  const { model: oldModel } = getListContext(payload.currentType || payload.type);
  const { model: newModel } = getListContext(payload.type);
  const existingEntry = await oldModel.findById(payload.existingEntryId);
  if (!existingEntry) {
    const moved = payload.currentType && payload.currentType !== payload.type
      ? await newModel.findById(payload.existingEntryId)
      : null;
    if (moved && moved.name === payload.name) {
      await finishApprovedEdit({
        interaction, payload, syncApproverDmMessages,
        notifyRequesterAboutDecision, lang, completeApproval,
      });
      return;
    }
    await closeApprovalWithAlert({
      interaction,
      completeApproval,
      embed: buildLocalizedAlert('dialogue.listEdit.originalMissing', lang),
      lang,
    });
    return;
  }

  const args = { interaction, payload, requestId, existingEntry, oldModel, newModel, lang, completeApproval, beforeWrite };
  const isTypeChange = payload.currentType && payload.currentType !== payload.type;
  const isScopeChange = payload.type === 'black' && payload.scope
    && payload.scope !== (existingEntry.scope || 'global');
  if (isTypeChange || isScopeChange || payload.additionalNames?.length > 0) {
    // Trusted membership may have changed while the request was waiting.
    const trustedNow = await findTrustedEditConflict(existingEntry, payload.additionalNames || []);
    if (trustedNow) {
      await closeApprovalWithAlert({
        interaction, lang, status: 'Blocked', completeApproval,
        embed: buildTrustedBlockEmbed(existingEntry.name, trustedNow.reason, { lang }),
      });
      return;
    }
  }
  const applied = isTypeChange
    ? await applyApprovedTypeChange(args)
    : await applyApprovedInPlaceUpdate(args);
  if (!applied) return;

  broadcastApprovedEdit({ payload, existingEntry, broadcastListChange });
  await finishApprovedEdit({
    interaction,
    payload,
    completeApproval,
    syncApproverDmMessages,
    notifyRequesterAboutDecision,
    lang,
  });
}
