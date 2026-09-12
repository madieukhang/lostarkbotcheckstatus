import TrustedUser from '../../../models/TrustedUser.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';

/** Check the complete proposed roster before a structural edit or approval write. */
export function findTrustedEditConflict(existing, additionalNames = []) {
  return TrustedUser.findOne(buildNameRosterQuery([
    existing.name,
    ...(existing.allCharacters || []),
    ...additionalNames,
  ])).collation({ locale: 'en', strength: 2 }).lean();
}
