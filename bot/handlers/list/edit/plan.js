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
  newLogs,
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
    newLogs ? t('dialogue.listEdit.change.logs', lang) : '',
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
  newLogs = '',
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
    newLogs,
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
      newLogs,
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

export function shouldApplyListEditImmediately({
  isOwner,
  isApprover,
  targetType,
  targetScope,
}) {
  return Boolean(
    isOwner
    || isApprover
    || (targetType === 'black' && targetScope === 'server')
  );
}
