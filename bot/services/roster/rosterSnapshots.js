/**
 * Shared persistence for the latest per-character roster metadata.
 * Every successful roster read goes through this helper so list broadcasts,
 * searches, and /la-roster all see the same class/ilvl/CP vocabulary.
 */

import RosterSnapshot from '../../models/RosterSnapshot.js';

function parseItemLevel(value) {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
        itemLevel: parseItemLevel(record?.itemLevel),
        classId: String(record?.classId || '').trim(),
        rosterName: String(rosterName || name).trim(),
        updatedAt: now,
      };
      const combatScore = normalizeCombatScore(record?.combatScore);
      if (combatScore) set.combatScore = combatScore;
      return {
        updateOne: {
          filter: { name },
          update: {
            $set: set,
          },
          upsert: true,
          collation: { locale: 'en', strength: 2 },
        },
      };
    })
    .filter(Boolean);

  if (operations.length === 0) return null;
  return RosterSnapshotModel.bulkWrite(operations, { ordered: false });
}
