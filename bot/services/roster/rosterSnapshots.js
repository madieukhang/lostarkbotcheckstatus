/**
 * Shared persistence for the latest per-character roster metadata.
 * Every successful roster read goes through this helper so list broadcasts,
 * searches, and /la-roster all see the same class/ilvl/CP vocabulary.
 */

import RosterSnapshot from '../../models/RosterSnapshot.js';
import { CASE_INSENSITIVE_COLLATION } from '../../models/collation.js';
import { parsePositiveNumber } from './parsers.js';

/**
 * Read one character's snapshot for the class icon on a card. Only the icon
 * depends on it, so a failed read returns null instead of failing the card.
 * @param {string} name - character name
 * @param {{RosterSnapshotModel?: object}} [options]
 * @returns {Promise<object|null>} the snapshot, or null
 */
export function findRosterSnapshot(name, { RosterSnapshotModel = RosterSnapshot } = {}) {
  return RosterSnapshotModel.findOne({ name })
    .collation(CASE_INSENSITIVE_COLLATION)
    .lean()
    .catch((err) => {
      console.warn('[roster] Snapshot read failed (card shows no class icon):', err?.message || err);
      return null;
    });
}

function normalizeCombatScore(value) {
  const text = String(value ?? '').trim();
  return text && text !== '?' ? text : '';
}

/**
 * Upsert a roster in one bulk operation.
 * @param {object[]} rosterCharacters
 * @param {string} rosterName
 * @param {{RosterSnapshotModel?: object, now?: Date}} [options]
 * @returns {Promise<object|null>}
 */
export async function upsertRosterSnapshots(
  rosterCharacters,
  rosterName,
  { RosterSnapshotModel = RosterSnapshot, now = new Date() } = {},
) {
  const operations = (Array.isArray(rosterCharacters) ? rosterCharacters : [])
    .map((record) => {
      const name = String(record?.name || '').trim();
      if (!name) return null;
      const set = {
        itemLevel: parsePositiveNumber(record?.itemLevel),
        classId: String(record?.classId || '').trim(),
        rosterName: String(rosterName || name).trim(),
        updatedAt: now,
      };
      const combatScore = normalizeCombatScore(record?.combatScore);
      if (combatScore) set.combatScore = combatScore;
      // Only written when known · a scrape that could not read the world
      // must not blank the value a previous one stored.
      const world = String(record?.world || '').trim();
      if (world) set.world = world;
      return {
        updateOne: {
          filter: { name },
          update: {
            $set: set,
          },
          upsert: true,
          collation: CASE_INSENSITIVE_COLLATION,
        },
      };
    })
    .filter(Boolean);

  if (operations.length === 0) return null;
  return RosterSnapshotModel.bulkWrite(operations, { ordered: false });
}

/**
 * The item level to show when a stored snapshot and a fresh lookup disagree.
 * Either can be the stale one: a snapshot dates from the last lookup of that
 * name, and Bible's search index can lag behind its character pages. Item
 * level practically never drops, so the higher value wins.
 * @param {...unknown} levels - item levels; non-numbers count as 0
 * @returns {number} the highest positive level, or 0
 */
export function higherItemLevel(...levels) {
  return Math.max(0, ...levels.map((level) => parsePositiveNumber(level)));
}

/**
 * Save the snapshots of a roster a command just fetched, without letting a
 * database failure break that command: list cards read item level and combat
 * score from these snapshots, and the fetch result itself stays usable.
 * @param {object[]} rosterCharacters - fetched character records
 * @param {string} rosterName - roster the records belong to
 * @param {{label?: string, upsertFn?: Function}} [options] - log prefix;
 *   the upsert is injectable for tests
 * @returns {Promise<void>}
 */
export async function saveRosterSnapshotsBestEffort(rosterCharacters, rosterName, {
  label = '[roster]',
  upsertFn = upsertRosterSnapshots,
} = {}) {
  try {
    await upsertFn(rosterCharacters || [], rosterName);
  } catch (err) {
    console.warn(`${label} Snapshot save after roster fetch failed (non-fatal):`, err.message);
  }
}
