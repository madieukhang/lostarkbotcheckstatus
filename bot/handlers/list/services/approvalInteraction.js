import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { NoticeKind } from '../../../utils/alertEmbed.js';
import { followUpAlert } from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { PENDING_APPROVAL_ACCESS, claimApproval, runClaimedApproval } from './pendingApprovalAccess.js';

/**
 * Build the same access notice for decision buttons and the read-only
 * evidence button.
 * @param {string} status - a PENDING_APPROVAL_ACCESS value; denial is a guard
 *   notice, a request another click is processing is busy, and anything else
 *   is expired.
 * @param {string} lang - locale for the message lookup.
 * @param {object} [options]
 * @param {boolean} [options.evidence=false] - use the evidence-specific
 *   denial copy for unauthorized clicks.
 * @returns {{kind: string, title: string, description: string}}
 */
export function buildApprovalAccessAlert(status, lang, { evidence = false } = {}) {
  const denied = status === PENDING_APPROVAL_ACCESS.notAuthorized;
  if (denied) {
    return { kind: NoticeKind.GUARD, ...t(`dialogue.approval.flow.${evidence ? 'evidenceNotAuthorized' : 'notAuthorized'}`, lang) };
  }
  return status === PENDING_APPROVAL_ACCESS.processing
    ? { kind: NoticeKind.BUSY, ...t('dialogue.approval.flow.processing', lang) }
    : { kind: NoticeKind.EXPIRED, ...t('dialogue.approval.flow.expired', lang) };
}

/**
 * Own authentication, acknowledgement and lease cleanup for all approval
 * decision buttons.
 * @param {Function} handleDecision - invoked with `{interaction, action,
 *   requestId, lang, payload, claim}` once the lease is held; its return
 *   value passes through to the caller.
 * @param {object} [options]
 * @param {object} [options.filters] - extra request filter (e.g.
 *   `{ action: 'bulk' }`) applied to both the request lookup and the lease
 *   claim.
 * @returns {Function} async handler for `action:requestId` custom-id buttons.
 */
export function createApprovalDecisionHandler(handleDecision, { filters = {} } = {}) {
  return async function handleApprovalDecision(interaction) {
    const [action, requestId] = interaction.customId.split(':');
    await interaction.deferUpdate();
    await connectDB();
    const languagePromise = getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const access = await claimApproval({
      interaction, PendingApprovalModel: PendingApproval, requestId,
      approverId: interaction.user.id, filters,
    });
    if (!access.payload) {
      await followUpAlert(interaction, buildApprovalAccessAlert(access.status, await languagePromise));
      return;
    }
    return runClaimedApproval(access.claim, async () => handleDecision({
      interaction, action, requestId, lang: await languagePromise, payload: access.payload, claim: access.claim,
    }));
  };
}

/** Handle completed/lost claims centrally; return false when the caller should show its retry UI. */
export async function handleApprovalClaimError({ claim, interaction, error, lang, label }) {
  if (claim.completed) {
    console.warn(`[approval] ${label} completed but its final notification failed:`, error.message);
    return true;
  }
  if (!claim.lost) return false;
  await followUpAlert(interaction, buildApprovalAccessAlert(PENDING_APPROVAL_ACCESS.processing, lang));
  return true;
}
