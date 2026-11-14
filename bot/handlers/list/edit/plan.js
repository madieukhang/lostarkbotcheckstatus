import { resolveRaidLabel } from '../../../models/Raid.js';
import { parseAdditionalNames } from '../../../utils/names.js';
import { t } from '../../../services/i18n/index.js';

function buildAdditionalNamesChange(additionalNamesParsed, lang) {
  if (additionalNamesParsed.added.length === 0) return '';
  return additionalNamesParsed.duplicates.length > 0
    ? t('dialogue.listEdit.change.appendWithDuplicates', lang, {
      names: additionalNamesParsed.added.join(', '),
      duplicates: additionalNamesParsed.duplicates.join(', '),
    })
    : t('dialogue.listEdit.change.append', lang, {
      names: additionalNamesParsed.added.join(', '),
    });
}

function resolveTargetScope({ existingObject, targetType, newScope, guildDefaultScope }) {
  if (targetType !== 'black') return 'global';
  return [newScope, existingObject.scope, guildDefaultScope, 'global'].find(Boolean);
}

function didScopeChange({ isTypeChange, currentType, targetScope, existingObject }) {
  return !isTypeChange
    && currentType === 'black'
    && targetScope !== (existingObject.scope || 'global');
}

function buildListEditChanges({
  existing,
  existingObject,
  currentType,
  targetType,
  isTypeChange,
  isScopeChange,
  targetScope,
  newReason,
  newRaid,
  newImageUrl,
  additionalNamesParsed,
  lang,
}) {
  return [
    newReason ? t('dialogue.listEdit.change.reason', lang, {
      old: existing.reason,
      next: newReason,
    }) : '',
    isTypeChange ? t('dialogue.listEdit.change.list', lang, {
      old: t(`dialogue.broadcast.list.${currentType}`, lang),
      next: t(`dialogue.broadcast.list.${targetType}`, lang),
    }) : '',
    newRaid ? t('dialogue.listEdit.change.raid', lang, {
      old: existing.raid || t('dialogue.broadcast.notAvailable', lang),
      next: newRaid,
    }) : '',
    newImageUrl ? t('dialogue.listEdit.change.evidence', lang) : '',
    isScopeChange ? t('dialogue.listEdit.change.scope', lang, {
      old: existingObject.scope || 'global',
      next: targetScope,
    }) : '',
    buildAdditionalNamesChange(additionalNamesParsed, lang),
  ].filter(Boolean);
}

function hasRequestedListEditChanges(values) {
  return values.some(Boolean);
}

function isInvalidRaidInput(input, resolvedRaid) {
  return Boolean(input) && resolvedRaid === null;
}

function isScopeApplicable(newScope, targetType) {
  return !newScope || targetType === 'black';
}

export function buildListEditPlan({
  existing,
  currentType,
  guildDefaultScope = 'global',
  newReason = '',
  newType = '',
  newRaidInput = '',
  newImageUrl = '',
  newScope = '',
  additionalNamesRaw = '',
  lang = 'en',
}) {
  const targetType = newType || currentType;
  const isTypeChange = targetType !== currentType;
  const newRaid = resolveRaidLabel(newRaidInput, { allowCustom: targetType === 'watch' });
  const existingObject = existing.toObject?.() || existing;
  const targetScope = resolveTargetScope({
    existingObject,
    targetType,
    newScope,
    guildDefaultScope,
  });
  const isScopeChange = didScopeChange({
    isTypeChange,
    currentType,
    targetScope,
    existingObject,
  });
  const additionalNamesParsed = parseAdditionalNames(
    additionalNamesRaw,
    existing.allCharacters || [],
    existing.name
  );
  const changes = buildListEditChanges({
    existing,
    existingObject,
    currentType,
    targetType,
    isTypeChange,
    isScopeChange,
    targetScope,
    newReason,
    newRaid,
    newImageUrl,
    additionalNamesParsed,
    lang,
  });

  return {
    targetType,
    isTypeChange,
    newRaid,
    invalidRaid: isInvalidRaidInput(newRaidInput, newRaid),
    hasRequestedChanges: hasRequestedListEditChanges([
      newReason,
      newType,
      newRaidInput,
      newImageUrl,
      newScope,
      additionalNamesRaw,
    ]),
    scopeApplicable: isScopeApplicable(newScope, targetType),
    existingObject,
    targetScope,
    isScopeChange,
    additionalNamesParsed,
    changes,
  };
}

export function buildScopeConflictQuery({ existing, targetScope, guildId }) {
  return {
    name: existing.name,
    scope: targetScope,
    ...(targetScope === 'server' ? { guildId } : {}),
    _id: { $ne: existing._id },
  };
}

/**
 * Route scope expansion and new global blacklist entries through approval, even for owners.
 * A global entry is checked in every server, so its owner also needs an
 * approver to add names to it, move it to another list or change its scope;
 * a reason, raid or image change on an own entry still applies directly.
 * Server-scoped entries stay editable without approval only for the entry owner
 * or approvers · a stranger editing someone else's server entry goes through
 * the approval flow like every other non-owner edit.
 * @param {object} edit
 * @param {boolean} edit.isOwner - the editor added the entry
 * @param {boolean} edit.isApprover - the editor is an officer or senior
 * @param {string} edit.currentType - list the entry is on
 * @param {string} edit.currentScope - its scope now
 * @param {string} edit.targetType - list after the edit
 * @param {string} edit.targetScope - scope after the edit
 * @param {boolean} [edit.appendsNames] - the edit adds additional_names
 * @returns {boolean} true when the edit applies without approval
 */
export function shouldApplyListEditImmediately({
  isOwner,
  isApprover,
  currentType,
  currentScope,
  targetType,
  targetScope,
  appendsNames = false,
}) {
  if (isApprover) return true;
  const needsGlobalApproval = targetScope === 'global' && (
    (currentType === 'black' && currentScope === 'server')
    || (targetType === 'black' && currentType !== 'black')
  );
  const reshapesGlobalEntry = currentScope === 'global'
    && (appendsNames || targetType !== currentType || targetScope !== currentScope);
  return Boolean(isOwner) && !needsGlobalApproval && !reshapesGlobalEntry;
}
