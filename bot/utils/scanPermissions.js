import { isOfficerOrSenior } from './approverRoles.js';

/**
 * Officers and seniors are privileged for high-fanout Stronghold scans:
 * they can run operational parallel scans. Regular users can still run
 * the commands, but are limited to one active scan at a time.
 * @param {string} userId - Discord user id
 * @returns {boolean} true when the user may run scans in parallel
 */
export function isPrivilegedStrongholdScanUser(userId) {
  return isOfficerOrSenior(userId);
}
