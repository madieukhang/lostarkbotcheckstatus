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
  parseAdditionalNames,
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
  getListContext,
  buildTrustedBlockEmbed,
  isRequesterAutoApprover,
  isOfficerOrSenior,
} from '../helpers.js';
import { applyListEditNow } from './applyNow.js';
import { sendListEditApprovalRequest } from './approvalRequest.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';

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

    const raw = interaction.options.getString('name');
    const name = normalizeCharacterName(raw);
    const newReason = interaction.options.getString('reason')?.trim() || '';
    const newType = interaction.options.getString('type') || '';
    const newRaid = interaction.options.getString('raid')?.trim() || '';
    const newLogs = interaction.options.getString('logs')?.trim() || '';
    const imageAttachment = interaction.options.getAttachment('image');
    const newImageUrl = imageAttachment?.url || '';
    // Optional scope override · only valid for blacklist entries (validated below).
    const newScopeRaw = interaction.options.getString('scope') || '';
    const newScope = newScopeRaw === 'global' || newScopeRaw === 'server' ? newScopeRaw : '';
    // Manual alt append: officer/senior or entry owner only. Designed to
    // fill the gap where /la-list enrich cant run (target has hidden
    // roster AND no guild = no candidate pool to walk).
    const additionalNamesRaw = interaction.options.getString('additional_names') || '';

    // Defer FIRST so the rehost (download + upload, can take 1-3s) does not
    // cross Discord's 3-second interaction ack window. Discord keeps the
    // attachment URL valid through the deferred state, so rehost can still
    // download it after the defer.
    await deferReply(interaction);
    await connectDB();

    // Rehost the new image NOW (while CDN URL is still valid). Result is used
    // later in updateFields. If rehost fails or no evidence channel configured,
    // we fall back to storing the legacy URL (which will eventually expire).
    let newImageRehost = null;
    if (newImageUrl) {
      newImageRehost = await rehostImage(newImageUrl, client, {
        entryName: name,
        addedBy: getInteractionDisplayName(interaction),
        listType: '', // type may change in this edit; leave blank
      });
    }

    // Find existing entry across all lists (scope-aware for blacklist)
    const collation = { locale: 'en', strength: 2 };
    const query = buildNameRosterQuery(name);
    const editGuildId = interaction.guild.id;
    const editGuildConfig = await getGuildConfig(editGuildId);
    const editGuildDefaultScope = editGuildConfig?.defaultBlacklistScope || 'global';

    const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
      Blacklist.findOne(buildBlacklistQuery(query, editGuildId)).sort({ scope: -1 }).collation(collation),
      Whitelist.findOne(query).collation(collation),
      Watchlist.findOne(query).collation(collation),
    ]);

    const existing = blackEntry || whiteEntry || watchEntry;
    if (!existing) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.listEdit.command.notFound', lang, { name }),
        lang,
      });
      return;
    }

    const currentType = blackEntry ? 'black' : whiteEntry ? 'white' : 'watch';
    const currentLabel = t(`dialogue.broadcast.list.${currentType}`, lang);

    // Permission gate for additional_names: officer/senior or entry
    // owner only. The approval flow used for member edits does not
    // carry allCharacters changes through to the apply step, so reject
    // up front rather than silently dropping the option.
    if (additionalNamesRaw) {
      const isOwnerForAdd = existing.addedByUserId === interaction.user.id;
      const isApproverForAdd = isOfficerOrSenior(interaction.user.id);
      if (!isOwnerForAdd && !isApproverForAdd) {
        await editAlert(interaction, {
          severity: AlertSeverity.TRUSTED,
          ...t('dialogue.listEdit.command.additionalRestricted', lang),
          lang,
        });
        return;
      }
    }

    const additionalNamesParsed = parseAdditionalNames(
      additionalNamesRaw,
      existing.allCharacters || [],
      existing.name
    );

    // Check if anything is actually changing
    if (!newReason && !newType && !newRaid && !newLogs && !newImageUrl && !newScope && !additionalNamesRaw) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.listEdit.command.noChanges', lang),
        lang,
      });
      return;
    }

    const targetType = newType || currentType;
    const isTypeChange = targetType !== currentType;

    // Scope option validation: only meaningful for blacklist entries.
    // White/watch lists are always global by design · reject scope on non-blacklist
    // edits with a clear error rather than silently ignoring.
    if (newScope && targetType !== 'black') {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.listEdit.command.scopeNotApplicable', lang, { list: t(`dialogue.broadcast.list.${targetType}`, lang) }),
        lang,
      });
      return;
    }

    // Resolve target scope:
    //   - If user provided scope option → use it
    //   - Else if currently blacklist (no type change) → keep existing scope
    //   - Else if moving INTO blacklist → use guild default scope
    //   - Else (white/watch) → always 'global' (scope field unused there)
    const existingObjForScope = existing.toObject?.() || existing;
    const targetScope = targetType === 'black'
      ? (newScope || existingObjForScope.scope || editGuildDefaultScope)
      : 'global';

    // Detect actual scope change (only meaningful for blacklist→blacklist edits).
    // Cross-list moves carry their own scope handling in the move branch.
    const isScopeChange = !isTypeChange
      && currentType === 'black'
      && targetScope !== (existingObjForScope.scope || 'global');

    // Conflict detection for in-place scope change: would the new
    // {name, scope, guildId} combination collide with an existing entry?
    if (isScopeChange) {
      const newGuildId = targetScope === 'server' ? editGuildId : '';
      const conflictQuery = {
        name: existing.name,
        scope: targetScope,
        ...(targetScope === 'server' ? { guildId: newGuildId } : {}),
        _id: { $ne: existing._id },
      };
      const conflict = await Blacklist.findOne(conflictQuery)
        .collation(collation)
        .lean();
      if (conflict) {
        const conflictDesc = targetScope === 'global'
          ? t('dialogue.listEdit.command.scopeBlockedGlobal', lang)
          : t('dialogue.listEdit.command.scopeBlockedServer', lang);
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: t('dialogue.listEdit.command.scopeBlocked.title', lang),
          description: conflictDesc,
          footer: t('dialogue.listEdit.command.scopeBlocked.footer', lang),
          lang,
        });
        return;
      }
    }

    // Build changes summary
    const changes = [];
    if (newReason) changes.push(t('dialogue.listEdit.change.reason', lang, { old: existing.reason, next: newReason }));
    if (isTypeChange) changes.push(t('dialogue.listEdit.change.list', lang, { old: currentLabel, next: t(`dialogue.broadcast.list.${targetType}`, lang) }));
    if (newRaid) changes.push(t('dialogue.listEdit.change.raid', lang, { old: existing.raid || t('dialogue.broadcast.notAvailable', lang), next: newRaid }));
    if (newLogs) changes.push(t('dialogue.listEdit.change.logs', lang));
    if (newImageUrl) changes.push(t('dialogue.listEdit.change.evidence', lang));
    if (isScopeChange) changes.push(t('dialogue.listEdit.change.scope', lang, { old: existingObjForScope.scope || 'global', next: targetScope }));
    if (additionalNamesParsed.added.length > 0) {
      const line = additionalNamesParsed.duplicates.length > 0
        ? t('dialogue.listEdit.change.appendWithDuplicates', lang, { names: additionalNamesParsed.added.join(', '), duplicates: additionalNamesParsed.duplicates.join(', ') })
        : t('dialogue.listEdit.change.append', lang, { names: additionalNamesParsed.added.join(', ') });
      changes.push(line);
    }

    // Catch the no-op case: user provided scope option but it matches the
    // existing scope, and no other fields are being changed. Rejecting here
    // keeps the success message honest (otherwise it'd say "edited" with an
    // empty change list).
    if (changes.length === 0) {
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.listEdit.command.noEffective', lang),
        lang,
      });
      return;
    }

    // Trusted user guard: block adding/moving trusted users to any list
    if (isTypeChange) {
      const trustedCheck = await TrustedUser.findOne(buildNameRosterQuery([
        existing.name,
        ...(existing.allCharacters || []),
      ])).collation({ locale: 'en', strength: 2 }).lean();
      if (trustedCheck) {
        const isSelf = trustedCheck.name.toLowerCase() === existing.name.toLowerCase();
        await editEmbed(
          interaction,
          buildTrustedBlockEmbed(existing.name, trustedCheck.reason, isSelf ? { lang } : { via: trustedCheck.name, lang })
        );
        return;
      }
    }

    // Check ownership: same person → apply now, different → approval
    // Auto-approve rule (final-state aware): if the FINAL state of this edit
    // results in a server-scoped blacklist entry, auto-approve. This means:
    //   - Demoting global → server: auto-approves (de-escalation, harmless)
    //   - Promoting server → global: requires approval (privilege escalation)
    //   - Editing fields on a local entry without changing scope: auto-approves
    //   - Moving white/watch → black with default scope=server: auto-approves
    // White/watch have no scope concept · they never auto-approve via this rule.
    const isOwner = existing.addedByUserId === interaction.user.id;
    const isApprover = isRequesterAutoApprover(interaction.user.id);
    const isLocalScope = targetType === 'black' && targetScope === 'server';

    if (isOwner || isApprover || isLocalScope) {
      await applyListEditNow({
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
      });
    } else {
      await sendListEditApprovalRequest({
        interaction,
        sendListAddApprovalToApprovers,
        existing,
        currentType,
        targetType,
        newReason,
        newRaid,
        newLogs,
        newImageUrl,
        newImageRehost,
        newScope,
        editGuildDefaultScope,
        changes,
        lang,
      });
    }
  }

  return handleListEditCommand;
}
