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
    .catch(() => null);
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
