/**
 * utils/approverRoles.js
 * Single source for the approver role checks over the configured ID lists.
 * MEMBER_APPROVER_IDS counts as neither role here; it only adds the legacy
 * bypass on a single /la-list add.
 */

import config from '../config.js';

/**
 * Whether the user is listed in SENIOR_APPROVER_IDS.
 * @param {string} userId - Discord user id
 * @returns {boolean} false for a missing id
 */
export function isSeniorApprover(userId) {
  if (!userId) return false;
  return config.seniorApproverIds.includes(userId);
}

/**
 * Whether the user is a senior or an officer. Stricter than the single-add
 * bypass: only seniors and officers auto-approve /la-list multiadd batches.
 * @param {string} userId - Discord user id
 * @returns {boolean} false for a missing id
 */
export function isOfficerOrSenior(userId) {
  if (!userId) return false;
  if (isSeniorApprover(userId)) return true;
  return config.officerApproverIds.includes(userId);
}
