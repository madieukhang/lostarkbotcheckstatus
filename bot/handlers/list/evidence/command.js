/**
 * handlers/list/evidence/command.js
 *
 * /la-evidence direct lookup. The "primary surface" for evidence images:
 * users who already know the character name can jump straight to the
 * evidence embed without paginating /la-list view or running /la-search.
 *
 * Renderer is reused from view/ui.js (buildEvidenceEmbed) so the visual
 * shape stays consistent across the three evidence entry points
 * (list view dropdown, search dropdown, this command).
 *
 * Autocomplete unions Blacklist/Whitelist/Watchlist by name prefix and
 * returns one option per (name, listType) tuple. Value encoding is
 * `<type>:<name>` so the handler picks the right list even when the
 * same name exists across types (rare cross-list overlap is real).
 */

import config from '../../../config.js';
import { connectDB } from '../../../db.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { buildEvidenceEmbed } from '../view/ui.js';
import { getListContext } from '../helpers.js';

const KNOWN_TYPES = ['black', 'white', 'watch'];
const COLLATION = { locale: 'en', strength: 2 };
const AUTOCOMPLETE_MAX = 25;
const PER_LIST_FETCH_CAP = 25;

function isOfficerOrSenior(userId) {
  if (!userId) return false;
  if (config.seniorApproverIds.includes(userId)) return true;
  return config.officerApproverIds.includes(userId);
}

function decorateEntry(entry, listType) {
  const ctx = getListContext(listType);
  return {
    ...entry,
    _icon: ctx.icon,
    _label: ctx.label,
    _color: ctx.color,
  };
}

/**
 * Parse the autocomplete-returned `name` value. Accepts either:
 *   - `<type>:<name>` shape (chosen via autocomplete)
 *   - `<name>` bare shape (user free-typed)
 * Returns { type, name } where type is null when the user free-typed.
 */
function parseNameValue(raw) {
  if (!raw) return { type: null, name: '' };
  const idx = raw.indexOf(':');
  if (idx > 0 && idx < raw.length - 1) {
    const candidate = raw.slice(0, idx);
    if (KNOWN_TYPES.includes(candidate)) {
      return { type: candidate, name: raw.slice(idx + 1).trim() };
    }
  }
  return { type: null, name: raw.trim() };
}

/**
 * Look up an entry by name across all three lists. Honors an explicit
 * `preferredType` (from autocomplete) before falling back to priority
 * order black > white > watch (most-severe-first when an entry exists
 * in multiple lists, e.g. moved between lists without cleanup).
 */
async function findEntryByName({ name, preferredType }) {
  const types = preferredType
    ? [preferredType, ...KNOWN_TYPES.filter((t) => t !== preferredType)]
    : KNOWN_TYPES;

  for (const type of types) {
    const { model } = getListContext(type);
    const entry = await model.findOne({ name }).collation(COLLATION).lean();
    if (entry) return { entry, type };
  }
  return { entry: null, type: null };
}

/**
 * Lookup matching entries for autocomplete. Prefix-matches against each
 * list's `name` field via case-insensitive collation, dedupes by
 * (name, listType), and caps at 25 total options (Discord limit).
 */
async function lookupAutocompleteCandidates(query) {
  await connectDB();
  const trimmed = (query || '').trim();
  if (!trimmed) {
    // Empty input -> return latest-added entries across all three lists.
    // Helps users browse without needing to remember a name prefix.
    const results = await Promise.all(KNOWN_TYPES.map(async (type) => {
      const { model } = getListContext(type);
      const docs = await model
        .find({})
        .sort({ addedAt: -1 })
        .limit(PER_LIST_FETCH_CAP)
        .lean();
      return docs.map((doc) => ({ doc, type }));
    }));
    return results.flat();
  }

  // Escape regex metacharacters and anchor to the start of the name field.
  // We use the index-friendly $regex with `^` prefix so MongoDB can hit
  // the compound index on (name, scope, guildId) for a range scan.
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixPattern = new RegExp(`^${escaped}`, 'i');

  const results = await Promise.all(KNOWN_TYPES.map(async (type) => {
    const { model } = getListContext(type);
    const docs = await model
      .find({ name: prefixPattern })
      .collation(COLLATION)
      .sort({ addedAt: -1 })
      .limit(PER_LIST_FETCH_CAP)
      .lean();
    return docs.map((doc) => ({ doc, type }));
  }));
  return results.flat();
}

/**
 * Build Discord autocomplete choices from raw lookup results. Dedupes
 * (name + type) combos to avoid showing the same row twice when the
 * same character was added under both global and a server scope.
 */
function buildAutocompleteChoices(rawResults) {
  const seen = new Set();
  const choices = [];

  for (const { doc, type } of rawResults) {
    const key = `${type}:${doc.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { icon } = getListContext(type);
    const reasonSnippet = doc.reason
      ? doc.reason.length > 50
        ? doc.reason.slice(0, 47) + '...'
        : doc.reason
      : 'No reason';
    // Discord caps name (label) at 100 chars and value at 100 chars.
    const label = `${icon} ${doc.name} - ${reasonSnippet}`.slice(0, 100);
    const value = `${type}:${doc.name}`.slice(0, 100);

    choices.push({ name: label, value });
    if (choices.length >= AUTOCOMPLETE_MAX) break;
  }

  return choices;
}

export async function handleListEvidenceAutocomplete(interaction) {
  try {
    const focused = interaction.options.getFocused(true);
    if (focused?.name !== 'name') {
      await interaction.respond([]);
      return;
    }
    const raw = await lookupAutocompleteCandidates(focused.value);
    const choices = buildAutocompleteChoices(raw);
    await interaction.respond(choices);
  } catch (err) {
    console.error('[evidence] Autocomplete error:', err.message);
    await interaction.respond([]).catch(() => {});
  }
}

export function createEvidenceHandlers({ client }) {
  async function handleListEvidenceCommand(interaction) {
    const rawNameOpt = interaction.options.getString('name', true);
    const requestedPublic = interaction.options.getBoolean('public') === true;
    const isPrivileged = isOfficerOrSenior(interaction.user.id);
    const usePublic = requestedPublic && isPrivileged;

    await interaction.deferReply({ ephemeral: !usePublic });

    try {
      await connectDB();
      const { type: preferredType, name } = parseNameValue(rawNameOpt);

      if (!name) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            title: 'Name Required',
            description: 'Pass a character name. Use autocomplete to pick from existing list entries.',
          })],
        });
        return;
      }

      const { entry, type } = await findEntryByName({ name, preferredType });

      if (!entry) {
        await interaction.editReply({
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.INFO,
            title: 'Not Listed',
            description: `**${name}** is not in any list (blacklist, whitelist, watchlist).`,
            footer: 'Try /la-search for fuzzy-match across the bible name index.',
          })],
        });
        return;
      }

      const decorated = decorateEntry(entry, type);
      const displayUrl = await resolveDisplayImageUrl(entry, client);

      // Officer privilege also unlocks the "Added by" field on the
      // evidence embed (same gate /la-list view uses for the same
      // ephemeral reply path).
      const evidenceEmbed = buildEvidenceEmbed(decorated, displayUrl, {
        includeAddedBy: isPrivileged,
      });

      // If the requester asked for public but is not privileged, render
      // a soft alert above the evidence so they understand why their
      // reply still landed ephemeral. Officer/senior see no banner.
      const embeds = [evidenceEmbed];
      if (requestedPublic && !isPrivileged) {
        embeds.unshift(buildAlertEmbed({
          severity: AlertSeverity.INFO,
          title: 'Public Mode Restricted',
          description: 'Only officers and seniors can broadcast evidence publicly. Showing privately instead.',
        }));
      }

      await interaction.editReply({ embeds });
    } catch (err) {
      console.error('[evidence] Lookup failed:', err.message);
      await interaction.editReply({
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          title: 'Lookup Failed',
          description: 'Could not load the evidence record.',
          fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
        })],
      });
    }
  }

  return { handleListEvidenceCommand };
}
