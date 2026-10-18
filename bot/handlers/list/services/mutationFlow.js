import { randomUUID } from 'node:crypto';

import { connectDB } from '../../../db.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { editEmbed, editNotice, editNoticeAfterSavedWrite } from '../../../utils/interactionReplies.js';
import { t } from '../../../services/i18n/index.js';
import { canChangeEntryWithoutApproval, isRequesterAutoApprover } from '../helpers.js';
import { attachNoteControls } from '../notes/pendingNotes.js';

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

/**
 * Show a list-add result on the deferred reply: its embeds when it has any,
 * otherwise its content as a success or warning notice.
 *
 * @param {object} interaction - the deferred interaction to answer
 * @param {object} result - executor result with `ok`, `content`, `embeds`
 *   and `components`
 * @param {object} [deps] - injectable reply helpers for tests
 * @returns {Promise<unknown>} the reply helper's result
 */
export async function renderListAddExecutionResult(
  interaction,
  result,
  {
    editEmbedFn = editEmbed,
    editNoticeFn = editNotice,
  } = {},
) {
  if ((result.embeds?.length ?? 0) > 0) {
    return editEmbedFn(interaction, result.embeds, {
      content: null,
      components: result.components ?? [],
    });
  }

  return editNoticeFn(interaction, result.content, {
    severity: result.ok ? AlertSeverity.SUCCESS : AlertSeverity.WARNING,
    components: result.components ?? [],
  });
}

/**
 * Execute the shared decision boundary for a list-add mutation.
 *
 * Officers and server-scoped blacklist writes execute immediately. Every other
 * request must be delivered to at least one approver before it is persisted.
 * A server-scoped request that finds a duplicate the requester did not add in
 * this server also goes to approval, since its note controls would change
 * that entry.
 * Surface-specific copy remains in callbacks so slash-add and Quick Add can
 * keep their own UI without duplicating the approval contract.
 * After the write succeeds, or the request is saved for approval, a failure
 * to show the confirmation card, or of `onQueued`, is logged and answered with
 * a plain notice that the write is saved, and does not throw. A failure to show
 * a refused write (`result.ok` false) still throws.
 *
 * @param {object} options - the `...Fn` options are injectable dependencies
 *   for tests
 * @param {object} options.interaction - the deferred interaction to answer
 * @param {object} options.payload - list-add payload from buildListMutationPayload
 * @param {string} options.lang - reply language
 * @param {object} options.PendingApprovalModel - the model the delivered
 *   approval is saved to
 * @param {Function} options.executeListAddToDatabase - writes the entry and
 *   reports isDuplicate and existingEntry
 * @param {Function} options.sendListAddApprovalToApprovers - DMs the approvers
 * @param {Function} [options.onDeliveryFailed] - called when no approver got the DM
 * @param {Function} [options.onQueued] - called after the pending approval is saved
 * @returns {Promise<{status: 'executed', result: object}|{status: 'delivery-failed'|'queued', delivery: object}>}
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
    const needsApproval = result.isDuplicate
      && !canChangeEntryWithoutApproval(payload, result.existingEntry, isRequesterAutoApproverFn);
    if (!needsApproval) {
      try {
        await renderExecutionResultFn(interaction, attachNoteControls(result, payload, lang));
      } catch (err) {
        // The entry is already written, so only a render failure of a
        // refusal still counts as a failed submission.
        if (!result.ok) throw err;
        console.warn('[list] Add result card failed after the write:', err.message);
        await editNoticeAfterSavedWrite(interaction, t('dialogue.common.savedCardFailed', lang));
      }
      return { status: 'executed', result };
    }
  }

  const delivery = await sendListAddApprovalToApprovers(interaction.guild, payload);
  if (!delivery.success) {
    await onDeliveryFailed?.(delivery);
    return { status: 'delivery-failed', delivery };
  }

  await connectDBFn();
  await persistDeliveredApproval(PendingApprovalModel, payload, delivery);
  try {
    await onQueued?.(delivery);
  } catch (err) {
    // The approvers were messaged and the request is saved; the request stays queued.
    console.warn('[list] Queued card failed after the request was saved:', err.message);
    await editNoticeAfterSavedWrite(interaction, t('dialogue.common.queuedCardFailed', lang), {
      severity: AlertSeverity.INFO,
    });
  }
  return { status: 'queued', delivery };
}
