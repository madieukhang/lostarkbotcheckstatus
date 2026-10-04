import TrustedUser from '../../../models/TrustedUser.js';
import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';

/** Check the complete proposed roster before a structural edit or approval write. */
export function findTrustedEditConflict(existing, additionalNames = []) {
  return TrustedUser.findOne(buildNameRosterQuery([
    existing.name,
    ...(existing.allCharacters || []),
    ...additionalNames,
  ])).collation(CASE_INSENSITIVE_COLLATION).lean();
}
