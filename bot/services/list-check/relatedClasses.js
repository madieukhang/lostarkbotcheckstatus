/**
 * Resolve class labels for secondary names rendered on a list-check row.
 * Snapshot hits stay DB-only. Legacy gaps use exact, direct-only Bible name
 * searches for the three visible alts, then persist the recovered metadata.
 */

import config from '../../config.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import { getClassName } from '../../models/Class.js';
import { mapWithConcurrency } from '../../utils/async.js';
import { normalizeNameKey } from '../../utils/names.js';
import { fetchNameSuggestions } from '../roster/search.js';
import { upsertRosterSnapshots } from '../roster/rosterSnapshots.js';
import {
  LIST_CHECK_ALT_PREVIEW_LIMIT,
  pickAltsForDisplay,
} from './format.js';
import { LIST_LOOKUP_COLLATION } from './lookup.js';

const RELATED_ENTRY_KEYS = Object.freeze([
  ['black', 'blackEntry'],
  ['white', 'whiteEntry'],
  ['watch', 'watchEntry'],
  ['trusted', 'trustedEntry'],
]);

function rememberNormalizedName(namesByKey, rawName) {
  const name = String(rawName || '').trim().normalize('NFC');
  const key = normalizeNameKey(name);
  if (key && !namesByKey.has(key)) namesByKey.set(key, name);
}

function collectRenderedRelatedNames(item) {
  const namesByKey = new Map();
  for (const [listType, entryKey] of RELATED_ENTRY_KEYS) {
    rememberNormalizedName(namesByKey, item[entryKey]?.name);
    rememberNormalizedName(namesByKey, item.matchDetails?.[listType]?.matchedName);
  }
  for (const altName of pickAltsForDisplay(item).slice(0, LIST_CHECK_ALT_PREVIEW_LIMIT)) {
    rememberNormalizedName(namesByKey, altName);
  }
  // The main row reads its class from snapClassName. Keeping it here would
  // repeat the same direct lookup after primary enrichment already ran.
  namesByKey.delete(normalizeNameKey(item.name));
  return namesByKey;
}

function resolveRelatedRosterName(item) {
  for (const [, entryKey] of RELATED_ENTRY_KEYS) {
    const name = String(item[entryKey]?.name || '').trim();
    if (name) return name;
  }
  return String(item.name || '').trim();
}

async function loadSnapshotClasses(wantedByKey, classByName) {
  if (wantedByKey.size === 0) return;
  try {
    const names = [...wantedByKey.values()].map(({ name }) => name);
    const snapshots = await RosterSnapshot.find({ name: { $in: names } })
      .collation(LIST_LOOKUP_COLLATION)
      .lean();
    for (const snapshot of snapshots) {
      const className = snapshot?.classId ? getClassName(snapshot.classId) : '';
      if (className) classByName.set(normalizeNameKey(snapshot.name), className);
    }
  } catch (err) {
    console.warn('[listcheck] Related-name snapshot lookup failed (non-fatal):', err.message);
  }
}

async function persistSnapshots(records) {
  const recordsByRoster = new Map();
  for (const record of records) {
    const group = recordsByRoster.get(record.rosterName) || [];
    group.push(record);
    recordsByRoster.set(record.rosterName, group);
  }
  await Promise.all([...recordsByRoster].map(async ([rosterName, group]) => {
    try {
      await upsertRosterSnapshots(group, rosterName);
    } catch (err) {
      console.warn('[listcheck] Related-name snapshot save failed (non-fatal):', err.message);
    }
  }));
}

async function hydrateMissingClasses(
  wantedByKey,
  classByName,
  { suggestionCache, suggestionContext } = {},
) {
  const missing = [...wantedByKey]
    .filter(([key]) => !classByName.has(key))
    .map(([key, value]) => ({ key, ...value }));
  if (missing.length === 0) return;

  const hydrated = (await mapWithConcurrency(
    missing,
    config.listcheckRosterLookupConcurrency || 3,
    async ({ key, name, rosterName }) => {
      const suggestions = await fetchNameSuggestions(name, {
        // This is cosmetic metadata repair, not a hidden-roster scan. Never
        // spend ScraperAPI quota merely to decorate an already-valid DB hit.
        allowScraperApi: false,
        timeoutMs: config.listcheckRosterLookupTimeoutMs || 6000,
        suggestionCache,
        suggestionContext,
      });
      const exact = suggestions?.find(
        (suggestion) => normalizeNameKey(suggestion.name) === key
      );
      const classId = String(exact?.cls || '').trim();
      if (!classId) return null;
      return {
        key,
        className: getClassName(classId),
        snapshot: {
          name: exact.name,
          classId,
          itemLevel: exact.itemLevel,
          rosterName,
        },
      };
    },
  )).filter(Boolean);

  for (const { key, className } of hydrated) classByName.set(key, className);
  if (hydrated.length > 0) {
    await persistSnapshots(hydrated.map(({ snapshot }) => snapshot));
  }
  console.log(
    `[listcheck] Related class hydration resolved=${hydrated.length}/${missing.length} via=direct-search`
  );
}

/**
 * Stamp each result with a normalized name -> className map for the secondary
 * names that its rendered row can contain. Mutates result items in place.
 */
export async function attachRelatedClassNames(results, options = {}) {
  const classByName = new Map();
  const relatedGroups = results.map((item) => {
    const namesByKey = collectRenderedRelatedNames(item);
    const itemKey = normalizeNameKey(item.name);
    if (itemKey && item.snapClassName) classByName.set(itemKey, item.snapClassName);
    return { item, namesByKey, rosterName: resolveRelatedRosterName(item) };
  });
  const wantedByKey = new Map();
  for (const { namesByKey, rosterName } of relatedGroups) {
    for (const [key, name] of namesByKey) {
      if (!classByName.has(key) && !wantedByKey.has(key)) {
        wantedByKey.set(key, { name, rosterName });
      }
    }
  }

  await loadSnapshotClasses(wantedByKey, classByName);
  await hydrateMissingClasses(wantedByKey, classByName, options);
  if (classByName.size === 0) return;

  for (const { item, namesByKey } of relatedGroups) {
    const related = {};
    for (const key of namesByKey.keys()) {
      const className = classByName.get(key);
      if (className) related[key] = className;
    }
    if (Object.keys(related).length > 0) item.relatedClasses = related;
  }
}
