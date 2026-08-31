/**
 * handlers/list/add/command.js
 * /la-list add: slash entry that opens the approval flow for adding
 * a character to one of the four lists (blacklist / whitelist /
 * watchlist / trusted). Performs bible roster scrape for `allCharacters`,
 * resolves evidence image rehost, then either auto-approves (officer)
 * or fans the request out to approvers via DM.
 */

import { randomUUID } from 'node:crypto';

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
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editEmbed,
} from '../../../utils/interactionReplies.js';
import {
  buildListAddApprovalEmbed,
} from '../helpers.js';
import {
  buildListMutationPayload,
  submitListMutation,
} from '../services/mutationFlow.js';

/**
 * Build the /la-list add slash-command handler.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client for
 *   REST resolves + DM fan-out via the approver service
 * @param {Function} deps.sendListAddApprovalToApprovers - approver DM
 *   broadcaster (returns the message IDs for sync tracking)
 * @param {Function} deps.executeListAddToDatabase - the actual
 *   add-to-DB executor, also called from the approval-button handler
 * @returns {Function} handleListAddCommand(interaction)
 */
export function createListAddCommandHandler({
  client,
  sendListAddApprovalToApprovers,
  executeListAddToDatabase,
}) {
  function readListAddRequest(interaction) {
    const type = interaction.options.getString('type', true);
    const raidInput = interaction.options.getString('raid') ?? '';
    return {
      type,
      name: normalizeCharacterName(interaction.options.getString('name', true).trim()),
      reason: interaction.options.getString('reason', true).trim(),
      raidInput,
      raid: resolveListAddRaidLabel(type, raidInput),
      logsUrl: interaction.options.getString('logs') ?? '',
      image: interaction.options.getAttachment('image'),
      inputScope: interaction.options.getString('scope') || '',
    };
  }

  function validateListAddRequest(interaction, request, lang) {
    const rules = [
      {
        invalid: () => !interaction.guild,
        message: () => t('dialogue.common.serverOnly', lang),
      },
      {
        invalid: () => !request.reason,
        message: () => t('dialogue.listAdd.command.reasonRequired', lang),
      },
      {
        invalid: () => request.raid === null,
        message: () => t('dialogue.listAdd.command.invalidRaid', lang, {
          raid: request.raidInput.trim(),
          list: request.type === 'black' ? 'blacklist' : 'whitelist',
        }),
      },
      {
        invalid: () => request.image?.contentType && !request.image.contentType.startsWith('image/'),
        message: () => t('dialogue.listAdd.command.invalidImage', lang, {
          type: request.image.contentType,
        }),
      },
    ];
    const violation = rules.find(({ invalid }) => invalid());
    return violation?.message() || null;
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
    });
  }

  function createListAddPayload(interaction, request, scope, rehostResult, lang) {
    return buildListMutationPayload({
      requestId: randomUUID(),
      interaction,
      requestedByDisplayName: getInteractionDisplayName(interaction),
      lang,
      type: request.type,
      name: request.name,
      reason: request.reason,
      raid: request.raid,
      logsUrl: request.logsUrl,
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

  async function submitListAddRequest(interaction, payload, lang) {
    const submission = await submitListMutation({
      interaction,
      payload,
      lang,
      PendingApprovalModel: PendingApproval,
      sendListAddApprovalToApprovers,
      executeListAddToDatabase,
      onDeliveryFailed: (delivery) => editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.listAdd.command.deliveryFailed', lang),
        fields: [{
          name: t('dialogue.broadcast.fields.reason', lang),
          value: delivery.reason || t('dialogue.common.unknown', lang),
          inline: false,
        }],
        lang,
      }),
      onQueued: () => editEmbed(
        interaction,
        buildListAddApprovalEmbed(interaction.guild, payload, {
          title: t('dialogue.listAdd.command.submittedTitle', lang),
          includeRequestedBy: false,
          lang,
        })
      ),
    });
    if (submission.status === 'queued') {
      await captureRequestReplyId(interaction, payload.requestId);
    }
  }

  async function handleListAddCommand(interaction) {
    const request = readListAddRequest(interaction);
    await deferReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const validation = validateListAddRequest(interaction, request, lang);
    if (validation) {
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...validation,
        lang,
      });
      return;
    }

    try {
      await connectDB();
      const scope = await resolveListAddScope(request, interaction.guild.id);
      const rehostResult = await rehostListAddImage(request, interaction);
      const payload = createListAddPayload(interaction, request, scope, rehostResult, lang);
      await submitListAddRequest(interaction, payload, lang);
    } catch (err) {
      console.error('[list] ❌ Proposal create/send failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.listAdd.command.proposalFailed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
    }
  }

  return handleListAddCommand;
}
