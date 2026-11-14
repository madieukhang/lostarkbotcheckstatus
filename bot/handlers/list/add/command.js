/**
 * handlers/list/add/command.js
 * /la-list add, and the add form's submit (add-form and Quick-Add): opens the
 * approval flow for adding a character to the blacklist, whitelist or
 * watchlist. Performs bible roster scrape for `allCharacters` and resolves
 * evidence image rehost.
 * Requests from any configured approver are written at once, and so are
 * server-scoped entries unless they find a duplicate the requester did not
 * add in this server; the rest go to the approvers via DM.
 */

import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import { resolveListAddRaidLabel } from '../../../models/Raid.js';
import UserPreference from '../../../models/UserPreference.js';
import {
  normalizeCharacterName,
  getInteractionDisplayName,
} from '../../../utils/names.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { getGuildConfig } from '../../../utils/scope.js';
import { rehostImage } from '../../../utils/imageRehost.js';
import { buildImageQuotaAlert, takeEvidenceUploads } from '../../../utils/evidenceQuota.js';
import { LIST_REASON_MAX_LENGTH } from '../../../models/listEntrySchema.js';
import { NoticeKind } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editEmbed,
} from '../../../utils/interactionReplies.js';
import {
  buildListAddApprovalEmbed,
  isListType,
} from '../helpers.js';
import {
  buildDeliveryFailedAlert,
  buildListMutationPayload,
  submitListMutation,
} from '../services/mutationFlow.js';

/**
 * The add request both the slash command and the add form hand to the add
 * handler: trimmed text, the normalized name and the resolved raid.
 * @param {object} fields
 * @param {string} fields.type - black, white or watch
 * @param {string} fields.name
 * @param {string} fields.reason
 * @param {string} [fields.raidInput] - raid as given; '' for none
 * @param {?object} [fields.image] - Discord attachment
 * @param {string} [fields.inputScope] - global, server or '' for the default
 * @returns {object} request; `raid` is null when the raid is not allowed for the list
 */
export function buildListAddRequest({ type, name, reason, raidInput = '', image = null, inputScope = '' }) {
  return {
    type,
    name: normalizeCharacterName(String(name ?? '').trim()),
    reason: String(reason ?? '').trim(),
    raidInput,
    raid: resolveListAddRaidLabel(type, raidInput),
    image,
    inputScope,
  };
}

/**
 * Build the /la-list add slash-command handler.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client for
 *   REST resolves + DM fan-out via the approver service
 * @param {Function} deps.sendListAddApprovalToApprovers - approver DM
 *   broadcaster (returns the message IDs for sync tracking)
 * @param {Function} deps.executeListAddToDatabase - the actual
 *   add-to-DB executor, also called from the approval-button handler
 * @returns {Function} handleListAddCommand(interaction, request?, options?)
 */
export function createListAddCommandHandler({
  client,
  sendListAddApprovalToApprovers,
  executeListAddToDatabase,
}) {
  function readListAddRequest(interaction) {
    return buildListAddRequest({
      type: interaction.options.getString('type', true),
      name: interaction.options.getString('name', true),
      reason: interaction.options.getString('reason', true),
      raidInput: interaction.options.getString('raid') ?? '',
      image: interaction.options.getAttachment('image'),
      inputScope: interaction.options.getString('scope') || '',
    });
  }

  function validateListAddRequest(interaction, request, lang) {
    const rules = [
      {
        invalid: () => !interaction.guild,
        kind: NoticeKind.GUARD,
        message: () => t('dialogue.common.serverOnly', lang),
      },
      {
        // The slash option offers only the lists; a form submit carries what its dropdown sent.
        invalid: () => !isListType(request.type),
        kind: NoticeKind.INPUT,
        message: () => t('dialogue.listAdd.command.invalidType', lang),
      },
      {
        invalid: () => !request.reason,
        kind: NoticeKind.INPUT,
        message: () => t('dialogue.listAdd.command.reasonRequired', lang),
      },
      {
        invalid: () => request.reason.length > LIST_REASON_MAX_LENGTH,
        kind: NoticeKind.INPUT,
        message: () => t('dialogue.listAdd.command.reasonTooLong', lang, { max: LIST_REASON_MAX_LENGTH }),
      },
      {
        // Every entry names the raid it came from.
        invalid: () => !String(request.raidInput).trim(),
        kind: NoticeKind.INPUT,
        message: () => t('dialogue.listAdd.command.raidRequired', lang),
      },
      {
        invalid: () => request.raid === null,
        kind: NoticeKind.INPUT,
        message: () => t('dialogue.listAdd.command.invalidRaid', lang, {
          raid: request.raidInput.trim(),
          list: request.type === 'black' ? 'blacklist' : 'whitelist',
        }),
      },
      {
        invalid: () => request.image?.contentType && !request.image.contentType.startsWith('image/'),
        kind: NoticeKind.INPUT,
        message: () => t('dialogue.listAdd.command.invalidImage', lang, {
          type: request.image.contentType,
        }),
      },
    ];
    const violation = rules.find(({ invalid }) => invalid());
    return violation ? { kind: violation.kind, ...violation.message() } : null;
  }

  async function resolveListAddScope(request, guildId) {
    if (request.inputScope) return request.inputScope;
    if (request.type !== 'black') return 'global';
    await connectDB();
    const guildConfig = await getGuildConfig(guildId);
    return guildConfig?.defaultBlacklistScope || 'global';
  }

  async function rehostListAddImage(request, interaction) {
    if (!request.image?.url) return null;
    return rehostImage(request.image.url, client, {
      entryName: request.name,
      addedBy: getInteractionDisplayName(interaction),
      listType: request.type,
      pending: true,
    });
  }

  function createListAddPayload(interaction, request, scope, rehostResult, lang) {
    return buildListMutationPayload({
      interaction,
      requestedByDisplayName: getInteractionDisplayName(interaction),
      lang,
      type: request.type,
      name: request.name,
      reason: request.reason,
      raid: request.raid,
      imageUrl: rehostResult?.freshUrl || request.image?.url || '',
      imageMessageId: rehostResult?.messageId || '',
      imageChannelId: rehostResult?.channelId || '',
      scope: request.type === 'black' ? scope : 'global',
    });
  }

  async function captureRequestReplyId(interaction, requestId) {
    try {
      const requestReply = await interaction.fetchReply();
      await PendingApproval.updateOne(
        { requestId },
        { $set: { requestMessageId: requestReply.id } }
      );
    } catch (err) {
      console.warn('[list] Failed to capture request reply message ID:', err.message);
    }
  }

  async function submitListAddRequest(interaction, payload, lang, { ephemeral }) {
    const submission = await submitListMutation({
      interaction,
      payload,
      lang,
      PendingApprovalModel: PendingApproval,
      sendListAddApprovalToApprovers,
      executeListAddToDatabase,
      onDeliveryFailed: (delivery) => editAlert(
        interaction,
        buildDeliveryFailedAlert('dialogue.listAdd.command.deliveryFailed', delivery, lang),
      ),
      onQueued: (delivery) => editEmbed(
        interaction,
        buildListAddApprovalEmbed(interaction.guild, payload, { forRequester: true, lang, snapshot: delivery.snapshot })
      ),
    });
    // The decision later replies to the request message, fetched from its
    // channel; a private reply cannot be fetched that way, so it is not recorded.
    if (submission.status === 'queued' && !ephemeral) {
      await captureRequestReplyId(interaction, payload.requestId);
    }
  }

  /**
   * @param {import('discord.js').Interaction} interaction - the slash command,
   *   or the add form's submit
   * @param {object} [formRequest] - from buildListAddRequest; read from the
   *   slash options when omitted
   * @param {{ephemeral?: boolean}} [options] - answer privately (Quick-Add)
   * @returns {Promise<void>}
   */
  async function handleListAddCommand(interaction, formRequest = null, { ephemeral = false } = {}) {
    const request = formRequest ?? readListAddRequest(interaction);
    await deferReply(interaction, { ephemeral });
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const validation = validateListAddRequest(interaction, request, lang);
    if (validation) {
      await editAlert(interaction, validation);
      return;
    }
    if (request.image?.url && !takeEvidenceUploads(interaction.user.id, 1)) {
      await editAlert(interaction, buildImageQuotaAlert(lang));
      return;
    }

    try {
      await connectDB();
      const scope = await resolveListAddScope(request, interaction.guild.id);
      const rehostResult = await rehostListAddImage(request, interaction);
      const payload = createListAddPayload(interaction, request, scope, rehostResult, lang);
      await submitListAddRequest(interaction, payload, lang, { ephemeral });
    } catch (err) {
      console.error('[list] ❌ Proposal create/send failed:', err.message);
      await editAlert(interaction, {
        kind: NoticeKind.FAILURE,
        ...t('dialogue.listAdd.command.proposalFailed', lang),
        fields: [{ name: t('dialogue.common.fields.details', lang), value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  return handleListAddCommand;
}
