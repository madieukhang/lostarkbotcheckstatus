export const PENDING_APPROVAL_ACCESS = Object.freeze({
  authorized: 'authorized',
  notAuthorized: 'not_authorized',
  expired: 'expired',
});

/**
 * Resolve an approver-scoped pending request without duplicating the
 * authorized lookup followed by the request-existence probe in every button
 * handler.
 */
export async function resolvePendingApprovalAccess({
  PendingApprovalModel,
  requestId,
  approverId,
  filters = {},
  consume = false,
}) {
  if (!PendingApprovalModel) {
    throw new TypeError('resolvePendingApprovalAccess requires PendingApprovalModel');
  }

  const requestFilter = { ...filters, requestId };
  const authorizedFilter = {
    ...requestFilter,
    approverIds: approverId,
  };
  const query = consume
    ? PendingApprovalModel.findOneAndDelete(authorizedFilter)
    : PendingApprovalModel.findOne(authorizedFilter);
  const payload = await query.lean();

  if (payload) {
    return {
      status: PENDING_APPROVAL_ACCESS.authorized,
      payload,
    };
  }

  const stillExists = await PendingApprovalModel.exists(requestFilter);
  return {
    status: stillExists
      ? PENDING_APPROVAL_ACCESS.notAuthorized
      : PENDING_APPROVAL_ACCESS.expired,
    payload: null,
  };
}
