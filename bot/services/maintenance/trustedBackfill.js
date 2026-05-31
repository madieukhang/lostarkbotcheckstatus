import TrustedUser from '../../models/TrustedUser.js';
import { buildRosterCharacters } from '../roster/index.js';
import { normalizeRosterNames } from '../../utils/names.js';

const MISSING_TRUSTED_ROSTER_QUERY = {
  $or: [
    { allCharacters: { $exists: false } },
    { allCharacters: { $size: 0 } },
  ],
};

export async function backfillTrustedRosterLinks({
  TrustedUserModel = TrustedUser,
  buildRosterCharactersFn = buildRosterCharacters,
  limit = 25,
} = {}) {
  const legacyEntries = await TrustedUserModel.find(MISSING_TRUSTED_ROSTER_QUERY)
    .sort({ addedAt: 1 })
    .limit(limit)
    .lean();

  if (legacyEntries.length === 0) {
    console.log('[maintenance] trusted roster backfill: nothing to do');
    return { scanned: 0, updated: 0, failed: 0 };
  }

  const stats = { scanned: legacyEntries.length, updated: 0, failed: 0 };
  for (const entry of legacyEntries) {
    try {
      const roster = await buildRosterCharactersFn(entry.name, {
        hiddenRosterFallback: true,
        timeoutMs: 10000,
      });
      const allCharacters = normalizeRosterNames(
        entry.name,
        roster?.hasValidRoster ? roster.allCharacters : []
      );
      await TrustedUserModel.updateOne(
        { _id: entry._id, ...MISSING_TRUSTED_ROSTER_QUERY },
        {
          $set: {
            allCharacters,
            enrichmentSource: roster?.hasValidRoster ? 'bible' : 'manual',
            enrichedAt: new Date(),
          },
        }
      );
      stats.updated += 1;
    } catch (err) {
      stats.failed += 1;
      console.warn(`[maintenance] trusted roster backfill failed for ${entry.name}: ${err.message}`);
    }
  }

  console.log(
    `[maintenance] trusted roster backfill: scanned=${stats.scanned}, updated=${stats.updated}, failed=${stats.failed}`
  );
  return stats;
}
