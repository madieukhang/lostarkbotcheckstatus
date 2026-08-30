/**
 * handlers/list/edit/command.js
 * /la-list edit: slash entry that edits an existing list entry's
 * reason/raid/scope/image/allCharacters. Auto-approves for officers
 * (applyListEditNow), otherwise fans out an approval request via
 * sendListEditApprovalRequest.
 */

import { connectDB } from '../../../db.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import TrustedUser from '../../../models/TrustedUser.js';
import UserPreference from '../../../models/UserPreference.js';
import {
  normalizeCharacterName,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editEmbed,
  replyAlert,
} from '../../../utils/interactionReplies.js';
import {
  buildTrustedBlockEmbed,
  isRequesterAutoApprover,
  isOfficerOrSenior,
} from '../helpers.js';
import { applyListEditNow } from './applyNow.js';
import { sendListEditApprovalRequest } from './approvalRequest.js';
import {
  buildListEditPlan,
  buildScopeConflictQuery,
  shouldApplyListEditImmediately,
} from './plan.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';

function readListEditInput(interaction) {
  const newScopeRaw = interaction.options.getString('scope') || '';
  return {
    name: normalizeCharacterName(interaction.options.getString('name')),
    newReason: interaction.options.getString('reason')?.trim() || '',
    newType: interaction.options.getString('type') || '',
    newRaidInput: interaction.options.getString('raid')?.trim() || '',
    newLogs: interaction.options.getString('logs')?.trim() || '',
    imageAttachment: interaction.options.getAttachment('image'),
    newScope: newScopeRaw === 'global' || newScopeRaw === 'server' ? newScopeRaw : '',
    additionalNamesRaw: interaction.options.getString('additional_names') || '',
  };
}

async function findListEditTarget({ name, guildId, collation }) {
  const query = buildNameRosterQuery(name);
  const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
    Blacklist.findOne(buildBlacklistQuery(query, guildId)).sort({ scope: -1 }).collation(collation),
    Whitelist.findOne(query).collation(collation),
    Watchlist.findOne(query).collation(collation),
  ]);
  return {
    existing: blackEntry || whiteEntry || watchEntry,
    currentType: blackEntry ? 'black' : whiteEntry ? 'white' : 'watch',
  };
}

async function findScopeConflict({
  isScopeChange,
  existing,
  targetScope,
  guildId,
  collation,
}) {
  if (!isScopeChange) return null;
  return Blacklist.findOne(buildScopeConflictQuery({
    existing,
    targetScope,
    guildId,
  })).collation(collation).lean();
}

async function findTrustedTypeChange(existing, isTypeChange, collation) {
  if (!isTypeChange) return null;
  return TrustedUser.findOne(buildNameRosterQuery([
    existing.name,
    ...(existing.allCharacters || []),
  ])).collation(collation).lean();
}

async function rejectInvalidListEditInput({
  interaction,
  existing,
  plan,
  newRaidInput,
  additionalNamesRaw,
  lang,
}) {
  if (plan.invalidRaid) {
    await editAlert(interaction, {
      severity: AlertSeverity.ERROR,
      ...t('dialogue.listAdd.command.invalidRaid', lang, {
        raid: newRaidInput,
        list: plan.targetType === 'black' ? 'blacklist' : 'whitelist',
      }),
      lang,
    });
    return true;
  }

  const mayAppendNames = existing.addedByUserId === interaction.user.id
    || isOfficerOrSenior(interaction.user.id);
  if (additionalNamesRaw && !mayAppendNames) {
    await editAlert(interaction, {
      severity: AlertSeverity.TRUSTED,
      ...t('dialogue.listEdit.command.additionalRestricted', lang),
      lang,
    });
    return true;
  }

  if (!plan.hasRequestedChanges) {
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.listEdit.command.noChanges', lang),
      lang,
    });
    return true;
  }

  if (!plan.scopeApplicable) {
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.listEdit.command.scopeNotApplicable', lang, {
        list: t(`dialogue.broadcast.list.${plan.targetType}`, lang),
      }),
      lang,
    });
    return true;
  }

  return false;
}

async function rejectInvalidListEditState({
  interaction,
  existing,
  plan,
  editGuildId,
  collation,
  lang,
}) {
  const conflict = await findScopeConflict({
    isScopeChange: plan.isScopeChange,
    existing,
    targetScope: plan.targetScope,
    guildId: editGuildId,
    collation,
  });
  if (conflict) {
    const descriptionKey = plan.targetScope === 'global'
      ? 'dialogue.listEdit.command.scopeBlockedGlobal'
      : 'dialogue.listEdit.command.scopeBlockedServer';
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      title: t('dialogue.listEdit.command.scopeBlocked.title', lang),
      description: t(descriptionKey, lang),
      footer: t('dialogue.listEdit.command.scopeBlocked.footer', lang),
      lang,
    });
    return true;
  }

  if (plan.changes.length === 0) {
    await editAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.listEdit.command.noEffective', lang),
      lang,
    });
    return true;
  }

  const trustedCheck = await findTrustedTypeChange(
    existing,
    plan.isTypeChange,
    collation
  );
  if (!trustedCheck) return false;

  const isSelf = trustedCheck.name.toLowerCase() === existing.name.toLowerCase();
  await editEmbed(
    interaction,
    buildTrustedBlockEmbed(
      existing.name,
      trustedCheck.reason,
      isSelf ? { lang } : { via: trustedCheck.name, lang }
    )
  );
  return true;
}

async function dispatchListEdit({
  interaction,
  client,
  sendListAddApprovalToApprovers,
  broadcastListChange,
  existing,
  currentType,
  plan,
  input,
  newImageUrl,
  newImageRehost,
  editGuildId,
  editGuildDefaultScope,
  lang,
}) {
  const isOwner = existing.addedByUserId === interaction.user.id;
  const applyImmediately = shouldApplyListEditImmediately({
    isOwner,
    isApprover: isRequesterAutoApprover(interaction.user.id),
    targetType: plan.targetType,
    targetScope: plan.targetScope,
  });

  if (applyImmediately) {
    await applyListEditNow({
      interaction,
      client,
      broadcastListChange,
      existing,
      currentType,
      targetType: plan.targetType,
      isTypeChange: plan.isTypeChange,
      isScopeChange: plan.isScopeChange,
      targetScope: plan.targetScope,
      editGuildId,
      editGuildDefaultScope,
      newReason: input.newReason,
      newRaid: plan.newRaid,
      newLogs: input.newLogs,
      newImageUrl,
      newImageRehost,
      newScope: input.newScope,
      additionalNamesParsed: plan.additionalNamesParsed,
      changes: plan.changes,
      isOwner,
      lang,
    });
    return;
  }

  await sendListEditApprovalRequest({
    interaction,
    sendListAddApprovalToApprovers,
    existing,
    currentType,
    targetType: plan.targetType,
    newReason: input.newReason,
    newRaid: plan.newRaid,
    newLogs: input.newLogs,
    newImageUrl,
    newImageRehost,
    newScope: input.newScope,
    editGuildDefaultScope,
    changes: plan.changes,
    lang,
  });
}

/**
 * Build the /la-list edit slash-command handler.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 * @param {Function} deps.sendListAddApprovalToApprovers - approver DM
 *   broadcaster (reused from the /la-list add flow; edit piggybacks on
 *   the same approval pipeline)
 * @param {Function} deps.broadcastListChange - guild broadcast
 * @returns {Function} handleListEditCommand(interaction)
 */
export function createListEditCommandHandler({
  client,
  sendListAddApprovalToApprovers,
  broadcastListChange,
}) {
  async function handleListEditCommand(interaction) {
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    if (!interaction.guild) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.common.serverOnly', lang),
        lang,
      });
      return;
    }

    const input = readListEditInput(interaction);
    const newImageUrl = input.imageAttachment?.url || '';
    // Manual alt append: officer/senior or entry owner only. Designed to
    // fill the gap where /la-list enrich cant run (target has hidden
    // roster AND no guild = no candidate pool to walk).

    // Defer FIRST so the rehost (download + upload, can take 1-3s) does not
    // cross Discord's 3-second interaction ack window. Discord keeps the
    // attachment URL valid through the deferred state, so rehost can still
    // download it after the defer.
    await deferReply(interaction);
    await connectDB();

    // Rehost the new image NOW (while CDN URL is still valid). Result is used
    // later in updateFields. Rehost failure or a missing evidence channel
    // falls back to the legacy URL, which eventually expires.
    let newImageRehost = null;
    if (newImageUrl) {
      newImageRehost = await rehostImage(newImageUrl, client, {
        entryName: input.name,
        addedBy: getInteractionDisplayName(interaction),
        listType: '', // type may change in this edit; leave blank
      });
    }

    // Find existing entry across all lists (scope-aware for blacklist)
    const collation = { locale: 'en', strength: 2 };
    const editGuildId = interaction.guild.id;
    const editGuildConfig = await getGuildConfig(editGuildId);
    const editGuildDefaultScope = editGuildConfig?.defaultBlacklistScope || 'global';

    const { existing, currentType } = await findListEditTarget({
      name: input.name,
      guildId: editGuildId,
      collation,
    });
    if (!existing) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.listEdit.command.notFound', lang, { name: input.name }),
        lang,
      });
      return;
    }

    const plan = buildListEditPlan({
      existing,
      currentType,
      guildDefaultScope: editGuildDefaultScope,
      newReason: input.newReason,
      newType: input.newType,
      newRaidInput: input.newRaidInput,
      newLogs: input.newLogs,
      newImageUrl,
      newScope: input.newScope,
      additionalNamesRaw: input.additionalNamesRaw,
      lang,
    });
    if (await rejectInvalidListEditInput({
      interaction,
      existing,
      plan,
      newRaidInput: input.newRaidInput,
      additionalNamesRaw: input.additionalNamesRaw,
      lang,
    })) return;

    if (await rejectInvalidListEditState({
      interaction,
      existing,
      plan,
      editGuildId,
      collation,
      lang,
    })) return;

    await dispatchListEdit({
      interaction,
      client,
      sendListAddApprovalToApprovers,
      broadcastListChange,
      existing,
      currentType,
      plan,
      input,
      newImageUrl,
      newImageRehost,
      editGuildId,
      editGuildDefaultScope,
      lang,
    });
  }

  return handleListEditCommand;
}
