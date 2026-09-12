import { connectDB } from '../../../db.js';
import PendingApproval from '../../../models/PendingApproval.js';
import UserPreference from '../../../models/UserPreference.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { followUpAlert, replyAlert } from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { PENDING_APPROVAL_ACCESS, acknowledgeAndClaimApproval, runClaimedApproval } from './pendingApprovalAccess.js';

/** Build the same access notice for decision buttons and the read-only evidence button. */
export function buildApprovalAccessAlert(status, lang, { evidence = false } = {}) {
  const denied = status === PENDING_APPROVAL_ACCESS.notAuthorized;
  const key = denied ? (evidence ? 'evidenceNotAuthorized' : 'notAuthorized')
    : status === PENDING_APPROVAL_ACCESS.processing ? 'processing' : 'expired';
  return { severity: denied ? AlertSeverity.ERROR : AlertSeverity.WARNING, ...t(`dialogue.approval.flow.${key}`, lang), lang };
}

/** Own authentication, acknowledgement and lease cleanup for all approval decision buttons. */
export function createApprovalDecisionHandler(handleDecision, { filters = {} } = {}) {
  return async function handleApprovalDecision(interaction) {
    const [action, requestId] = interaction.customId.split(':');
    await connectDB();
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const access = await acknowledgeAndClaimApproval({
      interaction, PendingApprovalModel: PendingApproval, requestId,
      approverId: interaction.user.id, filters,
    });
    if (!access.payload) {
      await (access.acknowledged ? followUpAlert : replyAlert)(interaction, buildApprovalAccessAlert(access.status, lang));
      return;
    }
    return runClaimedApproval(access.claim, () => handleDecision({
      interaction, action, requestId, lang, payload: access.payload, claim: access.claim,
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
