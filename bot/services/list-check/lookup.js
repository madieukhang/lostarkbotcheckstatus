import Blacklist from '../../models/Blacklist.js';
import TrustedUser from '../../models/TrustedUser.js';
import Watchlist from '../../models/Watchlist.js';
import Whitelist from '../../models/Whitelist.js';
import { buildListEntryMaps, buildNameRosterQuery } from '../../utils/listEntryMap.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { CASE_INSENSITIVE_COLLATION } from '../../models/collation.js';

// Summary cards use the mirrored latest report. Detail clicks reload the full entry.
// Every note field is left out, so the history arrives as empty objects that
// only give its length.
const LIST_SUMMARY_PROJECTION = Object.fromEntries(
  ['at', 'reason', 'raid', 'byUserId', 'byName', 'requestId'].map((field) => [`notes.${field}`, 0]),
);

// A summary entry carries how many notes it reads as instead of the notes; an
// entry saved before notes existed reads its add as one note.
function summarizeNotes({ notes = [], ...entry }) {
  return { ...entry, noteCount: Math.max(notes.length, 1) };
}

/**
 * Execute the shared bulk list lookup used by search and both image/text check.
 * Keeping blacklist scoping and map precedence here prevents those surfaces
 * from drifting while still issuing the four independent Mongo queries in
 * parallel.
 * @param {string[]} names - primary and alias names to check
 * @param {{ guildId?: string }} [options] - requesting guild for blacklist visibility
 * @returns {Promise<{ maps: object }>} summary entries indexed by normalized name;
 *   list entries carry `noteCount` instead of `notes`
 */
export async function loadListLookup(names, { guildId } = {}) {
  const nameQuery = buildNameRosterQuery(names);
  const [black, white, watch, trusted] = await Promise.all([
    Blacklist.find(buildBlacklistQuery(nameQuery, guildId), LIST_SUMMARY_PROJECTION)
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean(),
    Whitelist.find(nameQuery, LIST_SUMMARY_PROJECTION).collation(CASE_INSENSITIVE_COLLATION).lean(),
    Watchlist.find(nameQuery, LIST_SUMMARY_PROJECTION).collation(CASE_INSENSITIVE_COLLATION).lean(),
    TrustedUser.find(nameQuery).collation(CASE_INSENSITIVE_COLLATION).lean(),
  ]);
  const entries = {
    black: black.map(summarizeNotes),
    white: white.map(summarizeNotes),
    watch: watch.map(summarizeNotes),
    trusted,
  };
  return { maps: buildListEntryMaps(entries, { preferredGuildId: guildId }) };
}
