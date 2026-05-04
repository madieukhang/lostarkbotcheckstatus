import config from '../config.js';

/**
 * Officers and seniors are privileged for high-fanout Stronghold scans:
 * they can run operational parallel scans. Regular users can still run
 * the commands, but are limited to one active scan at a time.
 */
export function isPrivilegedStrongholdScanUser(userId) {
  if (!userId) return false;
  if (config.seniorApproverIds.includes(userId)) return true;
  return config.officerApproverIds.includes(userId);
}
