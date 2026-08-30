/**
 * handlers/list/edit/applyNow.js
 * Auto-apply branch of /la-list edit · taken when the requester is an
 * officer (or otherwise auto-approver). Writes the edited entry to
 * the DB, preserves enrichmentSource + enrichedAt metadata across
 * cross-list moves so a future stale-loop doesn't treat the entry as
 * legacy null, then broadcasts the change.
 */

import {
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { editAlert, editEmbed } from '../../../utils/interactionReplies.js';
import { t } from '../../../services/i18n/index.js';
import {
  getListContext,
  buildListEditSuccessEmbed,
} from '../helpers.js';

export function buildMovePreflightQuery(existing, targetType, editGuildId) {
  const nameMatch = { $or: [{ name: existing.name }, { allCharacters: existing.name }] };
  if (targetType !== 'black') return nameMatch;
  return {
    $and: [nameMatch, {
      $or: [
        { scope: 'global' },
        { scope: { $exists: false } },
        { scope: 'server', guildId: editGuildId },
      ],
    }],
  };
}

export function resolveMoveImageFields(existing, newImageUrl, newImageRehost) {
  if (!newImageUrl) {
    return {
      imageUrl: existing.imageUrl || '',
      imageMessageId: existing.imageMessageId || '',
      imageChannelId: existing.imageChannelId || '',
    };
  }
  if (newImageRehost) {
    return {
      imageUrl: '',
      imageMessageId: newImageRehost.messageId,
      imageChannelId: newImageRehost.channelId,
    };
  }
  return { imageUrl: newImageUrl, imageMessageId: '', imageChannelId: '' };
}

function resolveMoveScopeFields({ targetType, newScope, existing, editGuildDefaultScope, editGuildId }) {
  if (targetType !== 'black') return {};
  const existingObj = existing.toObject?.() || existing;
  const scope = newScope || existingObj.scope || editGuildDefaultScope;
  return { scope, guildId: scope === 'server' ? editGuildId : '' };
}

export function buildMovedEntryData({
  existing,
  targetType,
  editGuildId,
  editGuildDefaultScope,
  newReason,
  newRaid,
  newLogs,
  newImageUrl,
  newImageRehost,
  newScope,
  additionalNamesParsed,
}) {
  const hasManualAlts = additionalNamesParsed.added.length > 0;
  return {
    name: existing.name,
    reason: newReason || existing.reason,
    raid: newRaid || existing.raid,
    logsUrl: newLogs || existing.logsUrl,
    ...resolveMoveImageFields(existing, newImageUrl, newImageRehost),
    allCharacters: [
      ...(existing.allCharacters || []),
      ...additionalNamesParsed.added,
    ],
    enrichmentSource: hasManualAlts ? 'manual' : (existing.enrichmentSource ?? null),
    enrichedAt: hasManualAlts ? new Date() : (existing.enrichedAt ?? null),
    addedByUserId: existing.addedByUserId,
    addedByTag: existing.addedByTag,
    addedByDisplayName: existing.addedByDisplayName,
    addedAt: existing.addedAt,
    ...resolveMoveScopeFields({
      targetType,
      newScope,
      existing,
      editGuildDefaultScope,
      editGuildId,
    }),
  };
}

function resolveUpdatedImageFields(newImageUrl, newImageRehost) {
  if (!newImageUrl) return {};
  if (newImageRehost) {
    return {
      imageUrl: '',
      imageMessageId: newImageRehost.messageId,
      imageChannelId: newImageRehost.channelId,
    };
  }
  return { imageUrl: newImageUrl, imageMessageId: '', imageChannelId: '' };
}

export function buildInPlaceUpdatePlan({
  newReason,
  newRaid,
  newLogs,
  newImageUrl,
  newImageRehost,
  isScopeChange,
  targetScope,
  editGuildId,
  additionalNamesParsed,
}) {
  const updateFields = {
    ...(newReason ? { reason: newReason } : {}),
    ...(newRaid ? { raid: newRaid } : {}),
    ...(newLogs ? { logsUrl: newLogs } : {}),
    ...resolveUpdatedImageFields(newImageUrl, newImageRehost),
    ...(isScopeChange ? {
      scope: targetScope,
      guildId: targetScope === 'server' ? editGuildId : '',
    } : {}),
  };
  const updateOps = { $set: updateFields };
  if (additionalNamesParsed.added.length > 0) {
    updateOps.$addToSet = { allCharacters: { $each: additionalNamesParsed.added } };
    updateFields.enrichmentSource = 'manual';
    updateFields.enrichedAt = new Date();
  }
  return { updateFields, updateOps };
}

async function renderEditSuccess({
  interaction,
  client,
  entry,
  changes,
  type,
  isMove,
  lang,
}) {
  const freshDisplayUrl = await resolveDisplayImageUrl(entry, client);
  await editEmbed(
    interaction,
    buildListEditSuccessEmbed(entry.toObject?.() || entry, {
      changes,
      type,
      freshDisplayUrl,
      requesterDisplayName: getInteractionDisplayName(interaction),
      isMove,
      lang,
    }),
    { content: null }
  );
}

async function applyTypeChange(args) {
  const { model: oldModel } = getListContext(args.currentType);
  const { model: newModel } = getListContext(args.targetType);
  const targetDupe = await newModel.findOne(
    buildMovePreflightQuery(args.existing, args.targetType, args.editGuildId)
  ).collation({ locale: 'en', strength: 2 }).lean();

  if (targetDupe) {
    await editAlert(args.interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.listEdit.moveBlocked', args.lang, { name: args.existing.name }),
      lang: args.lang,
    });
    return false;
  }

  // Create first, then delete old: a failed create must preserve the source.
  const movedEntry = await newModel.create(buildMovedEntryData(args));
  await oldModel.deleteOne({ _id: args.existing._id });
  await renderEditSuccess({
    interaction: args.interaction,
    client: args.client,
    entry: movedEntry,
    changes: args.changes,
    type: args.targetType,
    isMove: true,
    lang: args.lang,
  });
  return true;
}

function buildEditedEntry(existing, updateFields, additionalNames) {
  const editedEntry = { ...(existing.toObject?.() || existing), ...updateFields };
  if (additionalNames.length === 0) return editedEntry;
  editedEntry.allCharacters = [...(existing.allCharacters || []), ...additionalNames];
  return editedEntry;
}

async function applyInPlaceEdit(args) {
  const { model } = getListContext(args.currentType);
  const { updateFields, updateOps } = buildInPlaceUpdatePlan(args);
  try {
    await model.updateOne({ _id: args.existing._id }, updateOps);
  } catch (err) {
    if (err.code !== 11000 || !args.isScopeChange) throw err;
    await editAlert(args.interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.listEdit.scopeRaced', args.lang),
      lang: args.lang,
    });
    return false;
  }

  const editedEntry = buildEditedEntry(
    args.existing,
    updateFields,
    args.additionalNamesParsed.added
  );
  await renderEditSuccess({
    interaction: args.interaction,
    client: args.client,
    entry: editedEntry,
    changes: args.changes,
    type: args.currentType,
    isMove: false,
    lang: args.lang,
  });
  return true;
}

function broadcastAppliedEdit(args) {
  const entryObj = args.existing.toObject?.() || args.existing;
  const finalScope = args.targetType === 'black' ? args.targetScope : 'global';
  if (args.isOwner || finalScope === 'server') return;
  args.broadcastListChange('edited', {
    ...entryObj,
    reason: args.newReason || args.existing.reason,
    raid: args.newRaid || args.existing.raid,
    scope: finalScope,
  }, {
    type: args.targetType,
    guildId: args.interaction.guild.id,
    requestedByDisplayName: args.interaction.member?.displayName || args.interaction.user.username,
    requestedByTag: args.interaction.user.tag,
  }, { changes: args.changes }).catch(() => {});
}

/**
 * Apply a list-edit immediately (officer auto-approve path).
 * @param {object} args - the edit-flow context bag
 * @param {import('discord.js').Interaction} args.interaction
 * @param {import('discord.js').Client} args.client
 * @param {Function} args.broadcastListChange - guild broadcast
 * @param {object} args.existing - the Mongoose entry being edited
 * @param {string} args.currentType - blacklist | whitelist | watchlist
 * @param {string} args.targetType - the destination list type (same as
 *   currentType for in-place edit, different for cross-list move)
 *   · plus the rewritten payload fields (reason, raid, scope, image,
 *   allCharacters, …) and the updater identity.
 * @returns {Promise<void>}
 */
export async function applyListEditNow({
  interaction,
  client,
  broadcastListChange,
  existing,
  currentType,
  targetType,
  isTypeChange,
  isScopeChange,
  targetScope,
  editGuildId,
  editGuildDefaultScope,
  newReason,
  newRaid,
  newLogs,
  newImageUrl,
  newImageRehost,
  newScope,
  additionalNamesParsed,
  changes,
  isOwner,
  lang = 'en',
}) {
  const args = {
    interaction,
    client,
    broadcastListChange,
    existing,
    currentType,
    targetType,
    isTypeChange,
    isScopeChange,
    targetScope,
    editGuildId,
    editGuildDefaultScope,
    newReason,
    newRaid,
    newLogs,
    newImageUrl,
    newImageRehost,
    newScope,
    additionalNamesParsed,
    changes,
    isOwner,
    lang,
  };
  try {
    const applied = isTypeChange
      ? await applyTypeChange(args)
      : await applyInPlaceEdit(args);
    if (!applied) return;
    broadcastAppliedEdit(args);
  } catch (err) {
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.listEdit.applyFailed', lang),
      fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
      lang,
    });
  }
}
