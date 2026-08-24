/**
 * Identity verification shared by typed-name and screenshot list checks.
 * External discovery may propose a character, but only Bible/roster evidence
 * or an actual Mongo list record makes that identity safe to render or offer
 * through Quick Add.
 */

/**
 * Determine whether a result carries a real record from a bot-managed list.
 * @param {object|null|undefined} result - list-check or search result
 * @returns {boolean} true when at least one Mongo list entry is attached
 */
export function hasDatabaseListMatch(result) {
  return Boolean(
    result?.blackEntry
    || result?.black
    || result?.whiteEntry
    || result?.white
    || result?.watchEntry
    || result?.watch
    || result?.trustedEntry
    || result?.trusted
  );
}

/**
 * Accept identities proven by Bible/snapshot enrichment or by an existing
 * Mongo list entry. The list fallback is deliberate: a real moderation record
 * must not disappear merely because Bible is temporarily unavailable.
 * @param {object|null|undefined} result - list-check result
 * @returns {boolean} true when the identity is safe to present as a character
 */
export function isCharacterIdentityVerified(result) {
  return result?.identityVerified === true || hasDatabaseListMatch(result);
}

/**
 * Split a check batch without mutating its source order.
 * @param {Array<object>} results - list-check results
 * @returns {{verified: Array<object>, unverified: Array<object>}}
 */
export function partitionListCheckResultsByVerification(results) {
  const verified = [];
  const unverified = [];
  for (const result of results || []) {
    (isCharacterIdentityVerified(result) ? verified : unverified).push(result);
  }
  return { verified, unverified };
}
