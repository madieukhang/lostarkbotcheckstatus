/**
 * handlers/list/services/entrySuggestions.js
 * Name suggestions for list entries: a prefix search over the three lists,
 * the blacklist limited to what the viewer's server may see, turned into
 * Discord autocomplete choices that read "list icon, class, name, CP". A
 * choice is one line of text, so the class and CP come from the roster
 * snapshots and the reason and raid stay out. /la-evidence values a choice by list and id;
 * /la-list edit, remove and edit-form value it by name.
 */

import { connectDB } from '../../../db.js';
import { getClassEmoji, getClassName } from '../../../models/Class.js';
import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import RosterSnapshot from '../../../models/RosterSnapshot.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { LIST_TYPES, getListContext } from '../helpers.js';

// Discord shows at most 25 choices, each label and value at most 100 characters.
const AUTOCOMPLETE_MAX = 25;
const CHOICE_TEXT_MAX = 100;
const PER_LIST_FETCH_CAP = 25;
// With nothing typed, the suggestions are the newest entries across the lists.
const RECENT_LIMIT = 10;

const addedTime = ({ doc }) => new Date(doc.addedAt || 0).getTime();

/**
 * Class and combat power of the given characters from their roster
 * snapshots, keyed by lowercased name. A failed lookup leaves them out
 * rather than the suggestions.
 * @param {string[]} names
 * @returns {Promise<Map<string, {className: string, combatScore: string}>>}
 */
async function findRosterFacts(names) {
  if (names.length === 0) return new Map();
  try {
    const snapshots = await RosterSnapshot.find({ name: { $in: names } })
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean();
    return new Map(snapshots.map((snapshot) => {
      const combatScore = String(snapshot.combatScore ?? '').trim();
      return [snapshot.name.toLowerCase(), {
        className: getClassName(snapshot.classId),
        // A snapshot stores '?' when the score was not readable.
        combatScore: combatScore === '?' ? '' : combatScore,
      }];
    }));
  } catch (err) {
    console.warn('[list] Roster lookup for entry suggestions failed:', err.message);
    return new Map();
  }
}

/**
 * Entries whose name starts with the typed text, newest first per list; with
 * nothing typed, the 10 newest entries across the lists. The blacklist is
 * scope-filtered to the viewer's server, so a server only sees its own
 * server-scoped entries and the global ones.
 * @param {string} query - typed text
 * @param {string} guildId - viewer's server
 * @returns {Promise<Array<{doc: object, type: string, className?: string, combatScore?: string}>>}
 */
async function findEntrySuggestions(query, guildId) {
  await connectDB();
  const trimmed = (query || '').trim();

  const buildBaseQuery = () => {
    if (!trimmed) return {};
    // Escape regex metacharacters and anchor with `^` so MongoDB can hit
    // the compound (name, scope, guildId) index for a prefix range scan.
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { name: new RegExp(`^${escaped}`, 'i') };
  };

  const perListCap = trimmed ? PER_LIST_FETCH_CAP : RECENT_LIMIT;
  const found = (await Promise.all(LIST_TYPES.map(async (type) => {
    const { model } = getListContext(type);
    const scoped = buildScopedListQuery(type, buildBaseQuery(), guildId);
    const docs = await model
      .find(scoped)
      .collation(CASE_INSENSITIVE_COLLATION)
      .sort({ addedAt: -1 })
      .limit(perListCap)
      .lean();
    return docs.map((doc) => ({ doc, type }));
  }))).flat();
  const results = trimmed ? found : found.sort((a, b) => addedTime(b) - addedTime(a)).slice(0, RECENT_LIMIT);

  const facts = await findRosterFacts([...new Set(results.map(({ doc }) => doc.name))]);
  return results.map((result) => ({ ...result, ...facts.get(result.doc.name.toLowerCase()) }));
}

/**
 * Autocomplete choices for found entries, one per value, 25 at most.
 * @param {Array<{doc: object, type: string, className?: string}>} results - from findEntrySuggestions
 * @param {Function} toValue - ({doc, type}) => the value the command receives
 * @returns {Array<{name: string, value: string}>}
 */
export function buildEntryChoices(results, toValue) {
  const seen = new Set();
  const choices = [];

  for (const result of results) {
    const value = toValue(result).slice(0, CHOICE_TEXT_MAX);
    if (seen.has(value)) continue;
    seen.add(value);

    const { doc, type, className = '', combatScore = '' } = result;
    const { icon } = getListContext(type);
    // The class icon is an application emoji loaded at runtime; until it is,
    // or for a class without one, the class name stands in.
    const classEmoji = getClassEmoji(className);
    const classPrefix = classEmoji ? `${classEmoji} ` : (className && `${className} · `);
    // Local-scope tag helps an officer tell apart the same name appearing
    // under global vs server scope (rare but possible for blacklist).
    const scopeTag = type === 'black' && doc.scope === 'server' ? ' [S]' : '';
    const combatPower = combatScore && ` · CP ${combatScore}`;
    const label = `${icon} ${classPrefix}${doc.name}${scopeTag}${combatPower}`.slice(0, CHOICE_TEXT_MAX);

    choices.push({ name: label, value });
    if (choices.length >= AUTOCOMPLETE_MAX) break;
  }

  return choices;
}

/**
 * Answer an autocomplete with the entries matching the typed text; a failed
 * lookup answers no choices, so Discord is not left waiting.
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {string} query - typed text
 * @param {Function} toValue - ({doc, type}) => choice value
 * @returns {Promise<void>}
 */
export async function respondWithEntrySuggestions(interaction, query, toValue) {
  try {
    const results = await findEntrySuggestions(query, interaction.guild?.id);
    await interaction.respond(buildEntryChoices(results, toValue));
  } catch (err) {
    console.error('[list] Entry suggestions failed:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}

/**
 * Answer an autocomplete with matching entry names, for the commands that
 * take a name and resolve it across the lists themselves (edit, remove).
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @param {string} query - typed text
 * @returns {Promise<void>}
 */
export function respondWithEntryNames(interaction, query) {
  return respondWithEntrySuggestions(interaction, query, ({ doc }) => doc.name);
}
