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
 * Autocomplete (services/entrySuggestions.js) unions Blacklist/Whitelist/Watchlist by name prefix,
 * scope-filtered for blacklist so a guild only sees its own server-scoped
 * entries + global entries (owner guild sees everything · same model as
 * /la-list view). Value encoding is `<type>:<_id>` (Mongo ObjectId,
 * 24 hex chars, unambiguous across scope + cross-list overlap). Free-typed
 * names fall back to a scope-aware lookup so unauthenticated input still
 * respects the scope boundary.
 */

import { connectDB } from '../../../db.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, NoticeKind } from '../../../utils/alertEmbed.js';
import { deferReply, editAlert, editEmbed } from '../../../utils/interactionReplies.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { buildNoteHistoryRows } from '../notes/entryNotes.js';
import {
  buildNameRosterQuery,
  pickPreferredListEntry,
} from '../../../utils/listEntryMap.js';
import { buildEvidenceEmbed } from '../view/ui.js';
import GuildConfig from '../../../models/GuildConfig.js';
import UserPreference from '../../../models/UserPreference.js';
import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import { getGuildLanguage, getUserLanguage, t } from '../../../services/i18n/index.js';
import {
  LIST_TYPES,
  decorateListEntry,
  getListContext,
  isOfficerOrSenior,
  parseListEntryRef,
} from '../helpers.js';
import { respondWithEntrySuggestions } from '../services/entrySuggestions.js';

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

/**
 * Lookup an entry by Mongo _id (autocomplete path). Scope filter is still
 * applied for blacklist so a leaked or copy-pasted _id from another guild
 * cannot bypass the boundary. Returns null when the entry is not visible
 * to this guild even if it exists in the DB.
 */
async function findEntryById({ entryId, type, guildId }) {
  const { model } = getListContext(type);
  const query = buildScopedListQuery(type, { _id: entryId }, guildId);
  const entry = await model.findOne(query).collation(CASE_INSENSITIVE_COLLATION).lean();
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
    ? [preferredType, ...LIST_TYPES.filter((t) => t !== preferredType)]
    : LIST_TYPES;

  for (const type of types) {
    const { model } = getListContext(type);
    const query = buildScopedListQuery(type, buildNameRosterQuery(name), guildId);
    const entry = type === 'black'
      ? pickPreferredListEntry(
          await model.find(query).collation(CASE_INSENSITIVE_COLLATION).lean(),
          [name],
          { preferServerScope: true, preferredGuildId: guildId },
        )
      : await model.findOne(query).collation(CASE_INSENSITIVE_COLLATION).lean();
    if (entry) return { entry, type };
  }
  return { entry: null, type: null };
}

// The value encodes the Mongo _id so the command fetches the entry
// unambiguously even when the same name exists across lists or scopes.
const entryRefValue = ({ type, doc }) => `${type}:${doc._id}`;

/**
 * /la-evidence autocomplete: the entries matching the typed name.
 * @param {import('discord.js').AutocompleteInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleListEvidenceAutocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused?.name !== 'name') {
    await interaction.respond([]);
    return;
  }
  await respondWithEntrySuggestions(interaction, focused.value, entryRefValue);
}

export function createEvidenceHandlers({ client }) {
  async function handleListEvidenceCommand(interaction) {
    const rawNameOpt = interaction.options.getString('name', true);
    const requestedPublic = interaction.options.getBoolean('public') === true;
    const isPrivileged = isOfficerOrSenior(interaction.user.id);
    const usePublic = requestedPublic && isPrivileged;
    const viewerGuildId = interaction.guild?.id || '';
    const lang = usePublic
      ? await getGuildLanguage(viewerGuildId, { GuildConfigModel: GuildConfig })
      : await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

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
          kind: NoticeKind.INPUT,
          ...t('dialogue.evidenceCommand.nameRequired', lang),
        });
        return;
      }

      if (!entry) {
        const displayName = name || rawNameOpt;
        await editAlert(interaction, {
          kind: NoticeKind.EMPTY,
          ...t('dialogue.evidenceCommand.notListed', lang, { name: displayName }),
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
        lang,
      });

      // If the requester asked for public but is not privileged, render
      // a soft alert above the evidence so they understand why their
      // reply still landed ephemeral. Officer/senior see no banner.
      const embeds = [evidenceEmbed];
      if (requestedPublic && !isPrivileged) {
        embeds.unshift(buildAlertEmbed({
          kind: NoticeKind.GUARD,
          ...t('dialogue.evidenceCommand.publicRestricted', lang),
        }));
      }

      await editEmbed(interaction, embeds, { components: buildNoteHistoryRows(type, entry, lang) });
    } catch (err) {
      console.error('[evidence] Lookup failed:', err.message);
      await editAlert(interaction, {
        kind: NoticeKind.FAILURE,
        ...t('dialogue.evidenceCommand.failed', lang),
        fields: [{ name: t('dialogue.common.fields.details', lang), value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  return { handleListEvidenceCommand };
}
