/**
 * services/list-check/rosterNameTracking.js
 * Keeps renamed characters on their list entries. A checked name that matched
 * an entry only through a visible-roster alt shares that alt's Bible roster,
 * so it is added to the entry's allCharacters. Later checks then match it
 * directly, after its saved roster snapshot makes enrichment skip the roster
 * fetch that found the alt.
 */

import Blacklist from '../../models/Blacklist.js';
import Watchlist from '../../models/Watchlist.js';
import Whitelist from '../../models/Whitelist.js';

// Trusted entries are left out: trust is granted by an officer, not widened
// by a check.
const LIST_MODELS = Object.freeze({
  black: Blacklist,
  white: Whitelist,
  watch: Watchlist,
});

// A roster match means the checked name is on no entry of that list yet: the
// lookup keys every name and alt of the entries it found, so a tracked name
// would have matched as itself first.
function rosterMatchedWrite(item, listType) {
  const entry = item[`${listType}Entry`];
  const isRosterMatch = item.matchDetails?.[listType]?.kind === 'roster';
  return isRosterMatch && entry?._id ? { listType, entry, name: item.name } : null;
}

/**
 * Add each checked name that matched a list entry through a roster alt to
 * that entry's allCharacters. A trusted character is skipped: writing its name
 * onto a list entry would make the trusted guard block every later edit of
 * that entry. Best effort: a failed write is logged and the check result
 * stands.
 * @param {Array<object>} results - list-check results after trusted resolution
 * @returns {Promise<void>}
 */
export async function rememberRosterMatchedNames(results) {
  const writes = [];
  for (const item of results) {
    if (item.trustedEntry) continue;
    for (const listType of Object.keys(LIST_MODELS)) {
      const write = rosterMatchedWrite(item, listType);
      if (write) writes.push(write);
    }
  }
  if (writes.length === 0) return;

  const outcomes = await Promise.allSettled(writes.map(({ listType, entry, name }) => (
    LIST_MODELS[listType].updateOne({ _id: entry._id }, { $addToSet: { allCharacters: name } })
  )));
  outcomes.forEach((outcome, index) => {
    const { listType, entry, name } = writes[index];
    const where = `${listType}list entry ${entry.name}`;
    if (outcome.status === 'rejected') {
      console.warn(`[listcheck] Rename tracking skipped for ${name} on ${where}: ${outcome.reason?.message || outcome.reason}`);
    } else {
      console.log(`[listcheck] Rename tracking added ${name} to ${where}`);
    }
  });
}
