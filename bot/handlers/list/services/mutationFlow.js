import { randomUUID } from 'node:crypto';

import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { editEmbed, editNotice } from '../../../utils/interactionReplies.js';

export function buildListMutationPayload({
  requestId = randomUUID(),
  interaction = null,
  guildId = interaction?.guild?.id || '',
  channelId = interaction?.channelId || '',
  requester = interaction?.user,
  requestedByDisplayName = requester?.username || '',
  lang,
  createdAt = Date.now(),
  ...fields
}) {
  return {
    requestId,
    guildId,
    channelId,
    ...fields,
    requestedByUserId: requester?.id || '',
    requestedByTag: requester?.tag || '',
    requestedByName: requester?.username || '',
    requestedByDisplayName,
    ...(lang === undefined ? {} : { lang }),
    createdAt,
  };
}

export async function persistDeliveredApproval(PendingApprovalModel, payload, delivery) {
  return PendingApprovalModel.create({
    ...payload,
    approverIds: delivery.deliveredApproverIds,
    approverDmMessages: delivery.deliveredDmMessages,
  });
}

export async function renderListAddExecutionResult(
  interaction,
  result,
  lang,
  {
    editEmbedFn = editEmbed,
    editNoticeFn = editNotice,
  } = {},
) {
  if ((result.embeds?.length ?? 0) > 0) {
    return editEmbedFn(interaction, result.embeds ?? [], {
      content: null,
      components: result.components ?? [],
    });
  }

  return editNoticeFn(interaction, result.content, {
    severity: result.ok ? AlertSeverity.SUCCESS : AlertSeverity.WARNING,
    lang,
    components: result.components ?? [],
  });
}
