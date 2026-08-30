import { randomUUID } from 'node:crypto';

import ServerMonitorStateDefault from '../models/ServerMonitorState.js';
import { STATUS } from './serverStatus.js';

const DEFAULT_ALERT_CLAIM_MS = 2 * 60 * 1000;

/**
 * Persist one status observation and atomically claim a pending recovery
 * notification. Mongo is the source of truth so Railway restarts cannot erase
 * a maintenance -> online transition and overlapping containers cannot both
 * send the same alert.
 */
export async function observeServerStatus({
  server,
  status,
  ServerMonitorState = ServerMonitorStateDefault,
  now = () => new Date(),
  claimId = randomUUID(),
  claimMs = DEFAULT_ALERT_CLAIM_MS,
} = {}) {
  const observedAt = now();

  if (status === STATUS.UNKNOWN || status == null) {
    const previous = await ServerMonitorState.findOneAndUpdate(
      { serverName: server },
      {
        $set: { lastCheckTime: observedAt },
        $setOnInsert: {
          lastStatus: null,
          recoveryPending: false,
        },
      },
      { upsert: true, returnDocument: 'before' },
    );
    return {
      previousStatus: previous?.lastStatus ?? null,
      shouldNotify: false,
      claimId: null,
    };
  }

  if (status === STATUS.OFFLINE || status === STATUS.MAINTENANCE) {
    const previous = await ServerMonitorState.findOneAndUpdate(
      { serverName: server },
      {
        $set: {
          lastStatus: status,
          lastCheckTime: observedAt,
          recoveryPending: true,
        },
        $unset: { alertClaimId: '', alertClaimUntil: '' },
      },
      { upsert: true, returnDocument: 'before' },
    );
    return {
      previousStatus: previous?.lastStatus ?? null,
      shouldNotify: false,
      claimId: null,
    };
  }

  const claimUntil = new Date(observedAt.getTime() + claimMs);
  const claimed = await ServerMonitorState.findOneAndUpdate(
    {
      serverName: server,
      recoveryPending: true,
      $or: [
        { alertClaimUntil: null },
        { alertClaimUntil: { $lte: observedAt } },
      ],
    },
    {
      $set: {
        lastStatus: STATUS.ONLINE,
        lastCheckTime: observedAt,
        alertClaimId: claimId,
        alertClaimUntil: claimUntil,
      },
    },
    { returnDocument: 'before' },
  );

  if (claimed) {
    return {
      previousStatus: claimed.lastStatus ?? null,
      shouldNotify: true,
      claimId,
    };
  }

  const previous = await ServerMonitorState.findOneAndUpdate(
    { serverName: server },
    {
      $set: {
        lastStatus: STATUS.ONLINE,
        lastCheckTime: observedAt,
      },
      $setOnInsert: {
        recoveryPending: false,
      },
    },
    { upsert: true, returnDocument: 'before' },
  );
  return {
    previousStatus: previous?.lastStatus ?? null,
    shouldNotify: false,
    claimId: null,
  };
}

/**
 * Complete or release an alert claim. Failed Discord sends keep the recovery
 * pending so a later monitor tick can retry after the short lease expires.
 */
export async function finishRecoveryNotification({
  server,
  claimId,
  sent,
  ServerMonitorState = ServerMonitorStateDefault,
  now = () => new Date(),
} = {}) {
  if (!claimId) return false;

  const update = sent
    ? {
      $set: {
        recoveryPending: false,
        lastAlertTime: now(),
      },
      $unset: { alertClaimId: '', alertClaimUntil: '' },
    }
    : {
      $set: { recoveryPending: true },
      $unset: { alertClaimId: '', alertClaimUntil: '' },
    };

  const result = await ServerMonitorState.updateOne(
    { serverName: server, alertClaimId: claimId },
    update,
  );
  return Number(result?.modifiedCount) > 0;
}

export { DEFAULT_ALERT_CLAIM_MS };
