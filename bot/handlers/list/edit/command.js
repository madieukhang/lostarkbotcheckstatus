import { connectDB } from '../../../db.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import TrustedUser from '../../../models/TrustedUser.js';
import {
  normalizeCharacterName,
  getInteractionDisplayName,
  parseAdditionalNames,
} from '../../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../../utils/scope.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  isRequesterAutoApprover,
  isOfficerOrSenior,
} from '../helpers.js';
import { applyListEditNow } from './applyNow.js';
import { sendListEditApprovalRequest } from './approvalRequest.js';

export function createListEditCommandHandler({
  client,
  sendListAddApprovalToApprovers,
  broadcastListChange,
}) {
  async function handleListEditCommand(interaction) {
    if (!interaction.guild) {
      await interaction.reply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Server-Only Command',
          description: 'This command can only be used inside a Discord server, not in DMs.',
        })],
        ephemeral: true,
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
    // Optional scope override — only valid for blacklist entries (validated below).
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
    await interaction.deferReply();
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
    const query = { $or: [{ name }, { allCharacters: name }] };
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
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.ERROR,
          title: 'Entry Not Found',
          description: `**${name}** is not in any list (blacklist, whitelist, or watchlist).`,
          footer: 'Use /la-list view to browse existing entries.',
        })],
      });
      return;
    }

    const currentType = blackEntry ? 'black' : whiteEntry ? 'white' : 'watch';
    const { label: currentLabel } = getListContext(currentType);

    // Permission gate for additional_names: officer/senior or entry
    // owner only. The approval flow used for member edits does not
    // carry allCharacters changes through to the apply step, so reject
    // up front rather than silently dropping the option.
    if (additionalNamesRaw) {
      const isOwnerForAdd = existing.addedByUserId === interaction.user.id;
      const isApproverForAdd = isOfficerOrSenior(interaction.user.id);
      if (!isOwnerForAdd && !isApproverForAdd) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.TRUSTED,
            title: 'Officer-Only Option',
            description: 'The `additional_names` option is restricted to officers and the entry owner.',
            footer: 'Ask an officer to append the alts for you.',
          })],
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
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'No Changes Provided',
          description: 'You ran `/la-list edit` without setting any of the optional fields, so there is nothing to apply.',
          footer: 'Set at least one of: reason / type / raid / logs / image / scope / additional_names.',
        })],
      });
      return;
    }

    const targetType = newType || currentType;
    const isTypeChange = targetType !== currentType;

    // Scope option validation: only meaningful for blacklist entries.
    // White/watch lists are always global by design — reject scope on non-blacklist
    // edits with a clear error rather than silently ignoring.
    if (newScope && targetType !== 'black') {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Scope Not Applicable',
          description: `The \`scope\` option only applies to blacklist entries. ${targetType === 'white' ? 'Whitelist' : 'Watchlist'} entries are always global.`,
          footer: 'Drop the scope option, or change type:black if you want a server-scoped entry.',
        })],
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
          ? 'A global blacklist entry with this name already exists.'
          : 'A server-scoped blacklist entry with this name already exists in this server.';
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Scope Change Blocked',
            description: conflictDesc,
            footer: 'Remove the conflicting entry first, or merge them manually.',
          })],
        });
        return;
      }
    }

    // Build changes summary
    const changes = [];
    if (newReason) changes.push(`Reason: "${existing.reason}" → "${newReason}"`);
    if (isTypeChange) changes.push(`List: ${currentLabel} → ${getListContext(targetType).label}`);
    if (newRaid) changes.push(`Raid: "${existing.raid || 'N/A'}" → "${newRaid}"`);
    if (newLogs) changes.push(`Logs: updated`);
    if (newImageUrl) changes.push(`Evidence: updated`);
    if (isScopeChange) changes.push(`Scope: ${existingObjForScope.scope || 'global'} → ${targetScope}`);
    if (additionalNamesParsed.added.length > 0) {
      const line = additionalNamesParsed.duplicates.length > 0
        ? `Append alts: ${additionalNamesParsed.added.join(', ')} (skipped duplicates: ${additionalNamesParsed.duplicates.join(', ')})`
        : `Append alts: ${additionalNamesParsed.added.join(', ')}`;
      changes.push(line);
    }

    // Catch the no-op case: user provided scope option but it matches the
    // existing scope, and no other fields are being changed. Rejecting here
    // keeps the success message honest (otherwise it'd say "edited" with an
    // empty change list).
    if (changes.length === 0) {
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'No Effective Changes',
          description: 'The values you provided already match the current entry.',
        })],
      });
      return;
    }

    // Trusted user guard: block adding/moving trusted users to any list
    if (isTypeChange) {
      const trustedCheck = await TrustedUser.findOne({
        $or: [
          { name: existing.name },
          ...(existing.allCharacters?.length > 0 ? [{ name: { $in: existing.allCharacters } }] : []),
        ],
      }).collation({ locale: 'en', strength: 2 }).lean();
      if (trustedCheck) {
        const isSelf = trustedCheck.name.toLowerCase() === existing.name.toLowerCase();
        await interaction.editReply({
          embeds: [buildTrustedBlockEmbed(existing.name, trustedCheck.reason, isSelf ? {} : { via: trustedCheck.name })],
        });
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
    // White/watch have no scope concept — they never auto-approve via this rule.
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
      });
    }
  }

  return handleListEditCommand;
}
