import { randomUUID } from 'node:crypto';

import ServerMonitorStateDefault from '../models/ServerMonitorState.js';
import { STATUS } from './serverStatus.js';

const DEFAULT_ALERT_CLAIM_MS = 2 * 60 * 1000;
const DOWN_STATUSES = new Set([STATUS.OFFLINE, STATUS.MAINTENANCE]);
const OUTAGE_NOTICE = Object.freeze({ scheduled: 'scheduled', sent: 'sent' });
const NO_OUTAGE_NOTICE = Object.freeze({ shouldNotifyOutage: false, outageClaimId: null });

// An outage alert waits for a second down read in a row, so one bad page load
// cannot announce it. A downtime first seen inside the weekly schedule is
// marked scheduled and never announced, even when it runs past the window.
async function claimOutageNotice({
  server,
  previous,
  announceOutage,
  ServerMonitorState,
  observedAt,
  claimId,
  claimMs,
}) {
  if (!announceOutage) {
    await ServerMonitorState.findOneAndUpdate(
      { serverName: server, outageNotice: null },
      { $set: { outageNotice: OUTAGE_NOTICE.scheduled } },
      { returnDocument: 'before' },
    );
    return NO_OUTAGE_NOTICE;
  }
  if (!DOWN_STATUSES.has(previous?.lastStatus)) return NO_OUTAGE_NOTICE;

  const claimed = await ServerMonitorState.findOneAndUpdate(
    {
      serverName: server,
      outageNotice: null,
      $or: [
        { outageClaimUntil: null },
        { outageClaimUntil: { $lte: observedAt } },
      ],
    },
    {
      $set: {
        outageClaimId: claimId,
        outageClaimUntil: new Date(observedAt.getTime() + claimMs),
      },
    },
    { returnDocument: 'before' },
  );
  return claimed ? { shouldNotifyOutage: true, outageClaimId: claimId } : NO_OUTAGE_NOTICE;
}

/**
 * Persist one status observation and atomically claim a pending recovery
 * notification. Mongo is the source of truth so Railway restarts cannot erase
 * a maintenance -> online transition and overlapping containers cannot both
 * send the same alert. A down read can also claim an outage alert.
 * @param {object} options - server, status, and injectable model/clock/claim settings
 * @param {boolean} [options.announceOutage=false] - true outside the weekly
 *   schedule, where a confirmed downtime is announced as an outage
 * @returns {Promise<{previousStatus: string|null, shouldNotify: boolean, claimId: string|null, deliveryPending?: boolean, shouldNotifyOutage?: boolean, outageClaimId?: string|null}>}
 *   deliveryPending is true when the server is online but the recovery alert
 *   is still owed under another worker's claim, so polling must continue;
 *   shouldNotifyOutage is true when this read won the outage alert claim.
 */
export async function observeServerStatus({
  server,
  status,
  announceOutage = false,
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

  if (DOWN_STATUSES.has(status)) {
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
    const outage = await claimOutageNotice({
      server,
      previous,
      announceOutage,
      ServerMonitorState,
      observedAt,
      claimId,
      claimMs,
    });
    return {
      previousStatus: previous?.lastStatus ?? null,
      shouldNotify: false,
      claimId: null,
      ...outage,
    };
  }

  // Being back online closes any outage, so the next downtime is a new one.
  const clearOutage = { outageNotice: '', outageClaimId: '', outageClaimUntil: '' };
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
      $unset: clearOutage,
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
      $unset: clearOutage,
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
    // The claim filter missed while recovery is still pending: another
    // worker's lease holds it, possibly one that stopped before sending.
    deliveryPending: previous?.recoveryPending === true,
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

/**
 * Complete or release an outage alert claim. A failed send releases it, so
 * the next down read can claim and retry.
 * @param {object} options - server, claimId, sent, and an injectable model
 * @returns {Promise<boolean>} true when the claim was still held by claimId
 */
export async function finishOutageNotification({
  server,
  claimId,
  sent,
  ServerMonitorState = ServerMonitorStateDefault,
} = {}) {
  if (!claimId) return false;

  const releaseClaim = { outageClaimId: '', outageClaimUntil: '' };
  const update = sent
    ? { $set: { outageNotice: OUTAGE_NOTICE.sent }, $unset: releaseClaim }
    : { $unset: releaseClaim };
  const result = await ServerMonitorState.updateOne(
    { serverName: server, outageClaimId: claimId },
    update,
  );
  return Number(result?.modifiedCount) > 0;
}
