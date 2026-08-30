/**
 * Shared completion-state vocabulary for every /la-roster deep-scan entry
 * point. Keeping this decision in one place prevents the command, hidden
 * roster, and Continue-button paths from drifting as new terminal states are
 * added.
 */

/**
 * @param {object|null|undefined} result
 * @param {object} [options]
 * @param {boolean} [options.hasRemaining=false] - A resumable partial pass is
 *   not terminal and therefore should not send a completion DM.
 * @returns {'completed'|'no-alts'|'stopped-with-alts'|'stopped-no-alts'|null}
 */
export function resolveRosterScanOutcome(result, { hasRemaining = false } = {}) {
  if (!result) return null;

  const hasAlts = Array.isArray(result.alts) && result.alts.length > 0;
  if (result.cancelled || result.pausedForFailureStorm) {
    return hasAlts ? 'stopped-with-alts' : 'stopped-no-alts';
  }
  if (hasRemaining) return null;
  return hasAlts ? 'completed' : 'no-alts';
}
