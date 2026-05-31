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
 * Autocomplete unions Blacklist/Whitelist/Watchlist by name prefix,
 * scope-filtered for blacklist so a guild only sees its own server-scoped
 * entries + global entries (owner guild sees everything · same model as
 * /la-list view). Value encoding is `<type>:<_id>` (Mongo ObjectId,
 * 24 hex chars, unambiguous across scope + cross-list overlap). Free-typed
 * names fall back to a scope-aware lookup so unauthenticated input still
 * respects the scope boundary.
 */

import { connectDB } from '../../../db.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed } from '../../../utils/interactionReplies.js';
import { buildBlacklistScopeFilter } from '../../../utils/scope.js';
import { buildEvidenceEmbed } from '../view/ui.js';
import {
  decorateListEntry,
  getListContext,
  isOfficerOrSenior,
  parseListEntryRef,
} from '../helpers.js';

const KNOWN_TYPES = ['black', 'white', 'watch'];
const COLLATION = { locale: 'en', strength: 2 };
const AUTOCOMPLETE_MAX = 25;
const PER_LIST_FETCH_CAP = 25;

/**
 * Apply the blacklist scope filter on top of a base name query. Whitelist
 * and watchlist have no scope concept, so the base query passes through
 * unchanged for those types. Blacklist owner guild sees everything; other
 * guilds see global + own-server entries only.
 */
function applyScopeForType(type, baseQuery, guildId) {
  if (type !== 'black') return baseQuery;
  const scopeFilter = buildBlacklistScopeFilter(guildId);
  if (!scopeFilter) return baseQuery; // owner guild · no restriction
  return { $and: [baseQuery, scopeFilter] };
}

/**
 * Parse the `name` option value. Delegates to the shared
 * `parseListEntryRef` for the `<type>:<_id>` autocomplete shape, then
 * falls back to a bare-name read when the input was free-typed.
 * Returns `{ type, entryId, name }` where entryId is set only when
 * autocomplete supplied the canonical encoded value.
 */
function parseNameValue(raw) {
  if (!raw) return { type: null, entryId: null, name: '' };
  const ref = parseListEntryRef(raw);
  if (ref) return { type: ref.listType, entryId: ref.id, name: '' };
  return { type: null, entryId: null, name: String(raw).trim() };
}

export function buildListEvidenceNameQuery(name) {
  return { $or: [{ name }, { allCharacters: name }] };
}

/**
 * Lookup an entry by Mongo _id (autocomplete path). Scope filter is still
 * applied for blacklist so a leaked or copy-pasted _id from another guild
 * cannot bypass the boundary. Returns null when the entry is not visible
 * to this guild even if it exists in the DB.
 */
async function findEntryById({ entryId, type, guildId }) {
  const { model } = getListContext(type);
  const query = applyScopeForType(type, { _id: entryId }, guildId);
  const entry = await model.findOne(query).collation(COLLATION).lean();
  if (entry) return { entry, type };
  return { entry: null, type: null };
}

/**
 * Lookup an entry by free-typed name. Priority black > white > watch
 * (most-severe-first) so an officer who types a name that exists in
 * multiple lists lands on the actionable record. Scope filter applies
 * to blacklist so guild-A users do not see guild-B's server-scoped
 * entries even via direct name typing.
 */
async function findEntryByName({ name, preferredType, guildId }) {
  const types = preferredType
    ? [preferredType, ...KNOWN_TYPES.filter((t) => t !== preferredType)]
    : KNOWN_TYPES;

  for (const type of types) {
    const { model } = getListContext(type);
    const query = applyScopeForType(type, buildListEvidenceNameQuery(name), guildId);
    const entry = await model.findOne(query).collation(COLLATION).lean();
    if (entry) return { entry, type };
  }
  return { entry: null, type: null };
}

/**
 * Lookup matching entries for autocomplete. Prefix-matches against each
 * list's `name` field via case-insensitive collation, scope-filters the
 * blacklist results to the viewer's guild, dedupes by _id, caps at 25
 * total options (Discord limit).
 */
async function lookupAutocompleteCandidates(query, guildId) {
  await connectDB();
  const trimmed = (query || '').trim();

  const buildBaseQuery = (type) => {
    if (!trimmed) return {};
    // Escape regex metacharacters and anchor with `^` so MongoDB can hit
    // the compound (name, scope, guildId) index for a prefix range scan.
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { name: new RegExp(`^${escaped}`, 'i') };
  };

  const results = await Promise.all(KNOWN_TYPES.map(async (type) => {
    const { model } = getListContext(type);
    const baseQuery = buildBaseQuery(type);
    const scoped = applyScopeForType(type, baseQuery, guildId);
    const docs = await model
      .find(scoped)
      .collation(COLLATION)
      .sort({ addedAt: -1 })
      .limit(PER_LIST_FETCH_CAP)
      .lean();
    return docs.map((doc) => ({ doc, type }));
  }));
  return results.flat();
}

/**
 * Build Discord autocomplete choices from raw lookup results. Dedupes by
 * `_id` so an entry appearing twice in the union (shouldn't, but defense
 * in depth) renders once. Value encodes the Mongo _id so the handler
 * can fetch unambiguously even when the same name exists across types
 * or scopes.
 */
function buildAutocompleteChoices(rawResults) {
  const seen = new Set();
  const choices = [];

  for (const { doc, type } of rawResults) {
    const key = String(doc._id);
    if (seen.has(key)) continue;
    seen.add(key);

    const { icon } = getListContext(type);
    const reasonSnippet = doc.reason
      ? doc.reason.length > 50
        ? doc.reason.slice(0, 47) + '...'
        : doc.reason
      : 'No reason';
    // Local-scope tag helps an officer tell apart the same name appearing
    // under global vs server scope (rare but possible for blacklist).
    const scopeTag = type === 'black' && doc.scope === 'server' ? ' [S]' : '';
    // Discord caps name (label) and value at 100 chars each.
    const label = `${icon} ${doc.name}${scopeTag} - ${reasonSnippet}`.slice(0, 100);
    const value = `${type}:${doc._id}`.slice(0, 100);

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
    const raw = await lookupAutocompleteCandidates(focused.value, interaction.guild?.id);
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
    const viewerGuildId = interaction.guild?.id || '';

    await deferReply(interaction, { ephemeral: !usePublic });

    try {
      await connectDB();
      const { type: preferredType, entryId, name } = parseNameValue(rawNameOpt);

      // Autocomplete path: value carried an _id, look up unambiguously.
      // Scope filter still applied so a leaked _id from another guild
      // does not bypass the boundary.
      let entry = null;
      let type = null;
      if (entryId && preferredType) {
        ({ entry, type } = await findEntryById({
          entryId,
          type: preferredType,
          guildId: viewerGuildId,
        }));
      } else if (name) {
        // Free-typed path: priority lookup with scope filter for blacklist.
        ({ entry, type } = await findEntryByName({
          name,
          preferredType,
          guildId: viewerGuildId,
        }));
      } else {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Name Required',
          description: 'Pass a character name. Use autocomplete to pick from existing list entries.',
        });
        return;
      }

      if (!entry) {
        const displayName = name || rawNameOpt;
        await editAlert(interaction, {
          severity: AlertSeverity.INFO,
          title: 'Not Listed',
          description: `**${displayName}** is not in any list visible to this server (blacklist / whitelist / watchlist).`,
          footer: 'Try /la-search for fuzzy-match across the bible name index.',
        });
        return;
      }

      const decorated = decorateListEntry(entry, type);
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

      await editEmbed(interaction, embeds);
    } catch (err) {
      console.error('[evidence] Lookup failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Lookup Failed',
        description: 'Could not load the evidence record.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  return { handleListEvidenceCommand };
}
