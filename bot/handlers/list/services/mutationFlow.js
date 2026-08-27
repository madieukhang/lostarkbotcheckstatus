import { randomUUID } from 'node:crypto';

import { connectDB } from '../../../db.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { editEmbed, editNotice } from '../../../utils/interactionReplies.js';
import { isRequesterAutoApprover } from '../helpers.js';

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

/**
 * Execute the shared decision boundary for a list-add mutation.
 *
 * Officers and server-scoped blacklist writes execute immediately. Every other
 * request must be delivered to at least one approver before it is persisted.
 * Surface-specific copy remains in callbacks so slash-add and Quick Add can
 * keep their own UI without duplicating the approval contract.
 */
export async function submitListMutation({
  interaction,
  payload,
  lang,
  PendingApprovalModel,
  sendListAddApprovalToApprovers,
  executeListAddToDatabase,
  onDeliveryFailed = null,
  onQueued = null,
  connectDBFn = connectDB,
  isRequesterAutoApproverFn = isRequesterAutoApprover,
  renderExecutionResultFn = renderListAddExecutionResult,
}) {
  const autoApproved =
    isRequesterAutoApproverFn(payload.requestedByUserId)
    || payload.scope === 'server';

  if (autoApproved) {
    const result = await executeListAddToDatabase(payload);
    await renderExecutionResultFn(interaction, result, lang);
    return { status: 'executed', result };
  }

  const delivery = await sendListAddApprovalToApprovers(interaction.guild, payload);
  if (!delivery.success) {
    await onDeliveryFailed?.(delivery);
    return { status: 'delivery-failed', delivery };
  }

  await connectDBFn();
  await persistDeliveredApproval(PendingApprovalModel, payload, delivery);
  await onQueued?.(delivery);
  return { status: 'queued', delivery };
}
