import { randomUUID } from 'node:crypto';

export const PENDING_APPROVAL_ACCESS = Object.freeze({
  authorized: 'authorized',
  notAuthorized: 'not_authorized',
  expired: 'expired',
  processing: 'processing',
});

export const APPROVAL_LEASE_MS = 5 * 60 * 1000;

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
}) {
  if (!PendingApprovalModel) {
    throw new TypeError('resolvePendingApprovalAccess requires PendingApprovalModel');
  }

  const requestFilter = { ...filters, requestId };
  const authorizedFilter = {
    ...requestFilter,
    approverIds: approverId,
  };
  const payload = await PendingApprovalModel.findOne(authorizedFilter).lean();

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

/** Acknowledge first, then claim a durable, renewable lease for one chosen decision. */
export async function acknowledgeAndClaimApproval({
  interaction, now = Date.now, leaseMs = APPROVAL_LEASE_MS, renewIntervalMs = 60_000, ...options
}) {
  const access = await resolvePendingApprovalAccess(options);
  if (!access.payload) return { ...access, acknowledged: false };
  await interaction.deferUpdate();
  const { PendingApprovalModel, requestId, approverId, filters = {} } = options;
  const action = interaction.customId.split(':')[0];
  const token = randomUUID();
  const payload = await PendingApprovalModel.findOneAndUpdate({
    ...filters, requestId, approverIds: approverId,
    processingAction: { $in: [null, '', action] },
    $or: [{ processingUntil: null }, { processingUntil: { $lte: new Date(now()) } }],
  }, { $set: {
    processingAction: action, processingToken: token, processingUntil: new Date(now() + leaseMs),
  } }, { new: true }).lean();
  if (!payload) {
    const current = await resolvePendingApprovalAccess(options);
    return { ...current, payload: null, acknowledged: true,
      status: current.payload ? PENDING_APPROVAL_ACCESS.processing : current.status };
  }

  let closed = false;
  let completed = false;
  let lost = false;
  let timer;
  const ownerFilter = { requestId, processingToken: token };
  const leaseLost = () => Object.assign(new Error('Approval ownership changed; retry the active decision.'), { code: 'APPROVAL_LEASE_LOST' });
  const stop = () => clearInterval(timer);
  const claim = {
    get completed() { return completed; },
    get lost() { return lost; },
    stop,
    async assertOwned() {
      if (lost || closed) throw leaseLost();
      try {
        const renewed = await PendingApprovalModel.findOneAndUpdate({
          ...ownerFilter, processingUntil: { $gt: new Date(now()) },
        }, { $set: { processingUntil: new Date(now() + leaseMs) } }, { new: true }).lean();
        if (!renewed) throw leaseLost();
      } catch (err) {
        lost = true;
        throw Object.assign(leaseLost(), { cause: err });
      }
    },
    async complete() {
      if (lost || closed) throw leaseLost();
      const result = await PendingApprovalModel.deleteOne({ ...ownerFilter, processingUntil: { $gt: new Date(now()) } });
      if (result.deletedCount !== 1) { lost = true; throw leaseLost(); }
      completed = true;
      closed = true;
      stop();
    },
    async release(patch = {}, { clearDecision = false } = {}) {
      stop();
      if (closed) return;
      const result = await PendingApprovalModel.updateOne(ownerFilter, {
        $set: patch,
        $unset: { processingToken: '', processingUntil: '', ...(clearDecision ? { processingAction: '' } : {}) },
      });
      if (result.matchedCount !== 1) { lost = true; throw leaseLost(); }
      closed = true;
    },
  };
  if (renewIntervalMs > 0) {
    timer = setInterval(() => {
      claim.assertOwned().catch(err => { stop(); console.warn('[approval] Lease renewal failed:', err.message); });
    }, renewIntervalMs);
    timer.unref?.();
  }
  return { status: PENDING_APPROVAL_ACCESS.authorized, payload, claim, acknowledged: true };
}

/** Release unfinished decisions for retry; preserve their chosen action after partial writes. */
export async function runClaimedApproval(claim, execute) {
  try { return await execute(); }
  finally {
    await claim.release().catch(err => console.warn('[approval] Lease release failed:', err.message));
  }
}
