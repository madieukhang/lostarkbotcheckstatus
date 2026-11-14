/**
 * handlers/list/edit/command.js
 * /la-list edit, and the edit form's submit: edits an existing list entry's
 * reason/raid/scope/image/allCharacters. Auto-approves for officers
 * (applyListEditNow), otherwise fans out an approval request via
 * sendListEditApprovalRequest.
 */

import { connectDB } from '../../../db.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import UserPreference from '../../../models/UserPreference.js';
import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import {
  normalizeCharacterName,
  normalizeNameKey,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import {
  buildNameRosterQuery,
  pickPreferredListEntry,
} from '../../../utils/listEntryMap.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { buildImageQuotaAlert, takeEvidenceUploads } from '../../../utils/evidenceQuota.js';
import { LIST_REASON_MAX_LENGTH } from '../../../models/listEntrySchema.js';
import { NoticeKind } from '../../../utils/alertEmbed.js';
import { escapeLinkBrackets, truncateInlineText } from '../../../utils/discordText.js';
import {
  deferReply,
  editAlert,
  editEmbed,
  replyAlert,
} from '../../../utils/interactionReplies.js';
import {
  buildTrustedBlockEmbed,
  isOfficerOrSenior,
  isListType,
} from '../helpers.js';
import { applyListEditNow } from './applyNow.js';
import { sendListEditApprovalRequest } from './approvalRequest.js';
import { findTrustedEditConflict } from './trustedGuard.js';
import { findRosterSnapshot } from '../../../services/roster/index.js';
import {
  buildListEditPlan,
  buildScopeConflictQuery,
  shouldApplyListEditImmediately,
} from './plan.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';

// additional_names accepts up to 6000 characters; escaping can double the
// echoed part, and the alert description must stay under 4096.
const REFUSED_NAMES_ECHO_LIMIT = 1000;

/**
 * The edit input both the slash command and the edit form hand to the edit
 * handler. An empty field keeps the entry's current value.
 * @param {object} fields
 * @param {string} fields.name - entry to edit
 * @param {?string} [fields.reason]
 * @param {?string} [fields.type] - black, white or watch
 * @param {?string} [fields.raidInput]
 * @param {?object} [fields.image] - Discord attachment
 * @param {?string} [fields.scope] - global or server; anything else keeps it
 * @param {?string} [fields.additionalNames] - comma-separated alts
 * @returns {object} input for the edit plan
 */
export function buildListEditInput({ name, reason, type, raidInput, image = null, scope, additionalNames }) {
  return {
    name: normalizeCharacterName(name),
    newReason: reason?.trim() || '',
    newType: type || '',
    newRaidInput: raidInput?.trim() || '',
    imageAttachment: image,
    newScope: scope === 'global' || scope === 'server' ? scope : '',
    additionalNamesRaw: additionalNames || '',
  };
}

function readListEditInput(interaction) {
  return buildListEditInput({
    name: interaction.options.getString('name'),
    reason: interaction.options.getString('reason'),
    type: interaction.options.getString('type'),
    raidInput: interaction.options.getString('raid'),
    image: interaction.options.getAttachment('image'),
    scope: interaction.options.getString('scope'),
    additionalNames: interaction.options.getString('additional_names'),
  });
}

async function findListEditTarget({ name, guildId }) {
  const query = buildNameRosterQuery(name);
  const [blackEntries, whiteEntry, watchEntry] = await Promise.all([
    Blacklist.find(buildBlacklistQuery(query, guildId)).collation(CASE_INSENSITIVE_COLLATION),
    Whitelist.findOne(query).collation(CASE_INSENSITIVE_COLLATION),
    Watchlist.findOne(query).collation(CASE_INSENSITIVE_COLLATION),
  ]);
  const blackEntry = pickPreferredListEntry(blackEntries, [name], {
    preferServerScope: true,
    preferredGuildId: guildId,
  });
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
}) {
  if (!isScopeChange) return null;
  return Blacklist.findOne(buildScopeConflictQuery({
    existing,
    targetScope,
    guildId,
  })).collation(CASE_INSENSITIVE_COLLATION).lean();
}

async function rejectInvalidListEditInput({
  interaction,
  existing,
  plan,
  newRaidInput,
  newReason = '',
  additionalNamesRaw,
  imageContentType,
  lang,
}) {
  // Manual alt append: officer/senior or entry owner only. It fills the gap
  // where /la-list enrich cannot run (hidden roster and no guild, so there
  // is no candidate pool to walk).
  const mayAppendNames = existing.addedByUserId === interaction.user.id
    || isOfficerOrSenior(interaction.user.id);
  const rules = [
    {
      // The slash option offers only the lists; a form submit carries what its dropdown sent.
      invalid: () => !isListType(plan.targetType),
      alert: () => ({ kind: NoticeKind.INPUT, ...t('dialogue.listAdd.command.invalidType', lang) }),
    },
    {
      invalid: () => plan.invalidRaid,
      alert: () => ({
        kind: NoticeKind.INPUT,
        ...t('dialogue.listAdd.command.invalidRaid', lang, {
          raid: newRaidInput,
          list: plan.targetType === 'black' ? 'blacklist' : 'whitelist',
        }),
      }),
    },
    {
      invalid: () => imageContentType && !imageContentType.startsWith('image/'),
      alert: () => ({
        kind: NoticeKind.INPUT,
        ...t('dialogue.listAdd.command.invalidImage', lang, { type: imageContentType }),
      }),
    },
    {
      invalid: () => newReason.length > LIST_REASON_MAX_LENGTH,
      alert: () => ({
        kind: NoticeKind.INPUT,
        ...t('dialogue.listAdd.command.reasonTooLong', lang, { max: LIST_REASON_MAX_LENGTH }),
      }),
    },
    {
      invalid: () => additionalNamesRaw && !mayAppendNames,
      alert: () => ({
        kind: NoticeKind.GUARD,
        ...t('dialogue.listEdit.command.additionalRestricted', lang),
      }),
    },
    {
      invalid: () => plan.additionalNamesParsed.invalid.length > 0,
      alert: () => ({
        kind: NoticeKind.INPUT,
        ...t('dialogue.listEdit.command.invalidNames', lang, {
          names: escapeLinkBrackets(truncateInlineText(
            plan.additionalNamesParsed.invalid.join(', '),
            REFUSED_NAMES_ECHO_LIMIT,
          )),
        }),
      }),
    },
    {
      invalid: () => !plan.hasRequestedChanges,
      alert: () => ({
        kind: NoticeKind.INPUT,
        ...t('dialogue.listEdit.command.noChanges', lang),
      }),
    },
    {
      invalid: () => !plan.scopeApplicable,
      alert: () => ({
        kind: NoticeKind.INPUT,
        ...t('dialogue.listEdit.command.scopeNotApplicable', lang, {
          list: t(`dialogue.broadcast.list.${plan.targetType}`, lang),
        }),
      }),
    },
  ];
  const violation = rules.find(({ invalid }) => invalid());
  if (!violation) return false;
  await editAlert(interaction, violation.alert());
  return true;
}

async function rejectInvalidListEditState({
  interaction,
  existing,
  plan,
  editGuildId,
  lang,
}) {
  const conflict = await findScopeConflict({
    isScopeChange: plan.isScopeChange,
    existing,
    targetScope: plan.targetScope,
    guildId: editGuildId,
  });
  if (conflict) {
    const descriptionKey = plan.targetScope === 'global'
      ? 'dialogue.listEdit.command.scopeBlockedGlobal'
      : 'dialogue.listEdit.command.scopeBlockedServer';
    await editAlert(interaction, {
      kind: NoticeKind.INPUT,
      title: t('dialogue.listEdit.command.scopeBlocked.title', lang),
      description: t(descriptionKey, lang),
      tip: t('dialogue.listEdit.command.scopeBlocked.tip', lang),
    });
    return true;
  }

  if (plan.changes.length === 0) {
    await editAlert(interaction, {
      kind: NoticeKind.INPUT,
      ...t('dialogue.listEdit.command.noEffective', lang),
    });
    return true;
  }

  const needsTrustedCheck = plan.isTypeChange || plan.isScopeChange
    || plan.additionalNamesParsed.added.length > 0;
  const trustedCheck = needsTrustedCheck
    ? await findTrustedEditConflict(existing, plan.additionalNamesParsed.added)
    : null;
  if (!trustedCheck) return false;

  const isSelf = normalizeNameKey(trustedCheck.name) === normalizeNameKey(existing.name);
  const record = await findRosterSnapshot(existing.name);
  await editEmbed(
    interaction,
    buildTrustedBlockEmbed(
      existing.name,
      trustedCheck.reason,
      isSelf ? { lang, record } : { via: trustedCheck.name, lang, record }
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
  // Member approvers bypass approval only on their own single add; editing
  // an entry directly takes an officer or senior.
  const applyImmediately = shouldApplyListEditImmediately({
    isOwner,
    isApprover: isOfficerOrSenior(interaction.user.id),
    currentType,
    currentScope: plan.existingObject.scope || 'global',
    targetType: plan.targetType,
    targetScope: plan.targetScope,
    appendsNames: plan.additionalNamesParsed.added.length > 0,
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
      newRaid: plan.newRaid,      newImageUrl,
      newImageRehost,
      newScope: input.newScope,
      additionalNamesParsed: plan.additionalNamesParsed,
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
    newRaid: plan.newRaid,    newImageUrl,
    newImageRehost,
    newScope: input.newScope,
    editGuildDefaultScope,
    targetScope: plan.targetScope,
    additionalNames: plan.additionalNamesParsed.added,
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
 * @param {Function} [deps.rehostImageFn] - evidence image rehost
 * @returns {Function} handleListEditCommand(interaction, input?)
 */
export function createListEditCommandHandler({
  client,
  sendListAddApprovalToApprovers,
  broadcastListChange,
  rehostImageFn = rehostImage,
}) {
  /**
   * @param {import('discord.js').Interaction} interaction - the slash command,
   *   or the edit form's submit
   * @param {object} [formInput] - from buildListEditInput; read from the
   *   slash options when omitted
   * @returns {Promise<void>}
   */
  async function handleListEditCommand(interaction, formInput = null) {
    if (!interaction.guild) {
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
      await replyAlert(interaction, {
        kind: NoticeKind.GUARD,
        ...t('dialogue.common.serverOnly', lang),
      });
      return;
    }

    const input = formInput ?? readListEditInput(interaction);
    const newImageUrl = input.imageAttachment?.url || '';

    // Defer FIRST so the lookups and the rehost (download + upload, can take
    // 1-3s) do not cross Discord's 3-second interaction ack window.
    await deferReply(interaction);
    await connectDB();

    // Find existing entry across all lists (scope-aware for blacklist)
    const editGuildId = interaction.guild.id;
    const [lang, editGuildConfig, { existing, currentType }] = await Promise.all([
      getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference }),
      getGuildConfig(editGuildId),
      findListEditTarget({ name: input.name, guildId: editGuildId }),
    ]);
    const editGuildDefaultScope = editGuildConfig?.defaultBlacklistScope || 'global';
    if (!existing) {
      await editAlert(interaction, {
        kind: NoticeKind.EMPTY,
        ...t('dialogue.listEdit.command.notFound', lang, { name: input.name }),
      });
      return;
    }

    const plan = buildListEditPlan({
      existing,
      currentType,
      guildDefaultScope: editGuildDefaultScope,
      newReason: input.newReason,
      newType: input.newType,
      newRaidInput: input.newRaidInput,      newImageUrl,
      newScope: input.newScope,
      additionalNamesRaw: input.additionalNamesRaw,
      lang,
    });
    if (await rejectInvalidListEditInput({
      interaction,
      existing,
      plan,
      newRaidInput: input.newRaidInput,
      newReason: input.newReason,
      additionalNamesRaw: input.additionalNamesRaw,
      imageContentType: input.imageAttachment?.contentType || '',
      lang,
    })) return;

    if (await rejectInvalidListEditState({
      interaction,
      existing,
      plan,
      editGuildId,
      lang,
    })) return;

    // Rehost only an edit that passed every check, so a refused edit leaves
    // no copy in the evidence channel. Rehost failure or a missing evidence
    // channel falls back to the Discord URL, which eventually expires.
    if (newImageUrl && !takeEvidenceUploads(interaction.user.id, 1)) {
      await editAlert(interaction, buildImageQuotaAlert(lang));
      return;
    }
    let newImageRehost = null;
    if (newImageUrl) {
      newImageRehost = await rehostImageFn(newImageUrl, client, {
        entryName: input.name,
        addedBy: getInteractionDisplayName(interaction),
        listType: '', // type may change in this edit; leave blank
        pending: true,
      });
    }

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
