/**
 * handlers/list/services/entrySuggestions.js
 * Name suggestions for list entries: a prefix search over the three lists,
 * the blacklist limited to what the viewer's server may see, turned into
 * Discord autocomplete choices. /la-evidence values a choice by list and id;
 * /la-list edit, remove and edit-form value it by name.
 */

import { connectDB } from '../../../db.js';
import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { truncateInlineText } from '../../../utils/discordText.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { LIST_TYPES, getListContext } from '../helpers.js';

// Discord shows at most 25 choices.
const AUTOCOMPLETE_MAX = 25;
const PER_LIST_FETCH_CAP = 25;

/**
 * Entries whose name starts with the typed text, newest first per list.
 * The blacklist is scope-filtered to the viewer's server, so a server only
 * sees its own server-scoped entries and the global ones.
 * @param {string} query - typed text; empty lists the newest entries
 * @param {string} guildId - viewer's server
 * @returns {Promise<Array<{doc: object, type: string}>>}
 */
export async function findEntrySuggestions(query, guildId) {
  await connectDB();
  const trimmed = (query || '').trim();

  const buildBaseQuery = () => {
    if (!trimmed) return {};
    // Escape regex metacharacters and anchor with `^` so MongoDB can hit
    // the compound (name, scope, guildId) index for a prefix range scan.
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { name: new RegExp(`^${escaped}`, 'i') };
  };

  const results = await Promise.all(LIST_TYPES.map(async (type) => {
    const { model } = getListContext(type);
    const scoped = buildScopedListQuery(type, buildBaseQuery(), guildId);
    const docs = await model
      .find(scoped)
      .collation(CASE_INSENSITIVE_COLLATION)
      .sort({ addedAt: -1 })
      .limit(PER_LIST_FETCH_CAP)
      .lean();
    return docs.map((doc) => ({ doc, type }));
  }));
  return results.flat();
}

/**
 * Autocomplete choices for found entries, one per value, 25 at most.
 * @param {Array<{doc: object, type: string}>} results - from findEntrySuggestions
 * @param {string} lang - viewer language, for the missing-reason text
 * @param {Function} toValue - ({doc, type}) => the value the command receives
 * @returns {Array<{name: string, value: string}>}
 */
export function buildEntryChoices(results, lang, toValue) {
  const seen = new Set();
  const choices = [];

  for (const result of results) {
    // Discord caps name (label) and value at 100 chars each.
    const value = toValue(result).slice(0, 100);
    if (seen.has(value)) continue;
    seen.add(value);

    const { doc, type } = result;
    const { icon } = getListContext(type);
    const reasonSnippet = doc.reason
      ? truncateInlineText(doc.reason, 50)
      : t('listView.navigation.noReason', lang);
    // Local-scope tag helps an officer tell apart the same name appearing
    // under global vs server scope (rare but possible for blacklist).
    const scopeTag = type === 'black' && doc.scope === 'server' ? ' [S]' : '';
    const label = `${icon} ${doc.name}${scopeTag} - ${reasonSnippet}`.slice(0, 100);

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
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    await interaction.respond(buildEntryChoices(results, lang, toValue));
  } catch (err) {
    console.error('[list] Entry suggestions failed:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}
