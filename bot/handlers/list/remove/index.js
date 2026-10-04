/**
 * handlers/list/remove/index.js
 * /la-list remove: deletes a list entry, allowed only for the user who added
 * it (officers/seniors fall back to custodians for legacy entries that
 * predate ownership tracking). Shows a multi-list confirm picker when the
 * name exists on more than one list or scope, then removes the chosen one
 * and broadcasts the change.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';

import { connectDB } from '../../../db.js';
import { COLORS, padInlineRow, relativeTime } from '../../../utils/ui.js';
import RosterSnapshot from '../../../models/RosterSnapshot.js';
import {
  formatLinkedCharacter,
  renderTrackedAltsField,
  resolveRosterWorld,
  statMapFromRosterCharacters,
} from '../trackedAltsRender.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import UserPreference from '../../../models/UserPreference.js';
import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import { getInteractionDisplayName, normalizeCharacterName, normalizeNameKey } from '../../../utils/names.js';
import { buildBlacklistQuery } from '../../../utils/scope.js';
import {
  buildNameRosterQuery,
  pickPreferredListEntry,
} from '../../../utils/listEntryMap.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import { truncateInlineText } from '../../../utils/discordText.js';
import {
  deferReply,
  editAlert,
  editEmbed,
  updateEmbed,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t, tPick } from '../../../services/i18n/index.js';
import { getListContext, isOfficerOrSenior } from '../helpers.js';

const REMOVE_RESULT_PRESENTATIONS = [
  {
    matches: ({ oks, fails }) => fails.length > 0 && oks.length === 0,
    resolve: ({ name, lang }) => ({
      color: COLORS.warning,
      titleIcon: '⚠️',
      title: t('dialogue.remove.titles.blocked', lang, { name }),
    }),
  },
  {
    matches: ({ oks, fails }) => oks.length === 1 && fails.length === 0,
    resolve: ({ oks, name, lang }) => ({
      color: getListContext(oks[0].type).color,
      titleIcon: oks[0].icon,
      title: t('dialogue.remove.titles.one', lang, { list: oks[0].label, name }),
    }),
  },
  {
    matches: ({ oks }) => oks.length > 1,
    resolve: ({ oks, name, lang }) => ({
      color: COLORS.success,
      titleIcon: '🗑️',
      title: t('dialogue.remove.titles.many', lang, { count: oks.length, name }),
    }),
  },
  {
    matches: () => true,
    resolve: ({ name, lang }) => ({
      color: COLORS.warning,
      titleIcon: '⚠️',
      title: t('dialogue.remove.titles.mixed', lang, { name }),
    }),
  },
];

export function resolveRemoveResultPresentation(context) {
  return REMOVE_RESULT_PRESENTATIONS.find(({ matches }) => matches(context)).resolve(context);
}

/**
 * Render N outcome envelopes as one result card.
 *
 * A removal cannot be undone, and once this card is sent nothing about
 * the entry is left in the database. So the card is written as a receipt:
 * it keeps the reason it just deleted, and it records who removed it and
 * when.
 *
 * Color and title icon follow the strongest outcome present · any failure
 * tints warning, otherwise the list icon when a single type was removed.
 *
 * @param {Array<{ok: boolean, entry: object, type: string, label: string, icon: string, reason?: string}>} outcomes
 * @param {object} options
 * @param {string} options.name - the character name that was searched
 * @param {string} options.lang - locale for every label
 * @param {Map<string, object>} [options.statMap] - roster snapshots, for
 *   the removed name's class icon and the roster rows' class icon, ilvl and CP
 * @param {string} [options.world] - the entry's server, already resolved
 * @param {string} [options.removedBy] - display name of whoever ran it
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildRemoveResultCard(outcomes, {
  name,
  lang = 'en',
  statMap = new Map(),
  world = '',
  removedBy = '',
} = {}) {
  const oks = outcomes.filter((o) => o.ok);
  const fails = outcomes.filter((o) => !o.ok);
  const { color, titleIcon, title } = resolveRemoveResultPresentation({ oks, fails, name, lang });

  // After this card the reason is gone from the database, so it is kept
  // whole. Removing from several lists keeps each one, named by its list.
  const reasonValue = oks.length === 1
    ? String(oks[0].entry.reason || '').trim()
    : oks
      .filter((o) => String(o.entry.reason || '').trim())
      .map((o) => `${o.icon} **${o.label}**: ${o.entry.reason.trim()}`)
      .join('\n');

  const failedField = fails.length > 0 ? {
    name: `🚫 ${t('dialogue.remove.failedSection', lang)}`,
    value: fails.map((o) => {
      if (o.reason === 'legacy') {
        return `⚠️ ${t('dialogue.remove.legacy', lang, { list: o.label })}`;
      }
      const owner = o.entry.addedByTag || o.entry.addedByUserId;
      return `⛔ ${t('dialogue.remove.ownerOnly', lang, { list: o.label, owner })}`;
    }).join('\n').slice(0, 1024),
    inline: false,
  } : null;

  // Roster preview identifies the removal target. Scan all entries
  // (successes and failures) for allCharacters; the first one with > 1
  // char wins, since entries usually share the same roster. Rendered
  // through the shared renderer so the rows carry a class icon, ilvl and
  // CP like every other character list, primary included as the add and
  // view cards list it.
  const sourceEntry = outcomes.find(
    (o) => Array.isArray(o.entry.allCharacters) && o.entry.allCharacters.length > 1
  )?.entry;
  const rosterField = sourceEntry
    ? renderTrackedAltsField({
      names: sourceEntry.allCharacters,
      primaryName: sourceEntry.name,
      statMap,
      includePrimary: true,
      // The renderer appends its own "(N)", so the label must not carry one.
      label: `🧬 ${t('dialogue.broadcast.fields.trackedRosters', lang)}`,
      overflowTemplate: t('dialogue.remove.more', lang),
    })
    : null;

  const auditFields = padInlineRow([
    removedBy ? {
      name: `👤 ${t('dialogue.remove.removedBy', lang)}`,
      value: removedBy,
      inline: true,
    } : null,
    {
      name: `🕐 ${t('dialogue.remove.removedAt', lang)}`,
      value: relativeTime(new Date()),
      inline: true,
    },
    world ? {
      name: `🌍 ${t('dialogue.roster.server', lang)}`,
      value: `\`${world}\``,
      inline: true,
    } : null,
  ].filter(Boolean));

  const fields = [
    failedField,
    reasonValue ? {
      name: `📝 ${t('dialogue.broadcast.fields.reason', lang)}`,
      value: reasonValue.slice(0, 1024),
      inline: false,
    } : null,
    ...auditFields,
    rosterField,
  ].filter(Boolean);

  const embed = createArtistEmbed()
    .setTitle(`${titleIcon} ${title}`)
    .addFields(fields)
    .setColor(color)
    .setTimestamp();
  // The line says the entry was removed, so a card where nothing was
  // removed goes without it rather than contradict its own title.
  if (oks.length > 0) {
    embed.setDescription(tPick(`dialogue.remove.${reasonValue ? 'line' : 'lineNoReason'}`, lang, {
      name: formatLinkedCharacter(name, statMap.get(normalizeNameKey(name))),
    }));
  }
  if (fails.length > 0) embed.setFooter({ text: t('dialogue.remove.footerBlocked', lang) });
  return embed;
}

/**
 * Build the /la-list remove handler bag.
 * @param {object} deps
 * @param {object} deps.services - shared services
 *   (broadcastListChange for the post-remove guild notification)
 * @returns {{handleListRemoveCommand: Function}}
 */
export function createRemoveHandlers({ services }) {
  const { broadcastListChange } = services;

  async function handleListRemoveCommand(interaction) {
    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);

    await deferReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    try {
      await connectDB();

      const removeGuildId = interaction.guild?.id || '';
      const nameQuery = buildNameRosterQuery(name);
      const [blackEntries, whiteEntry, watchEntry] = await Promise.all([
        Blacklist.find(buildBlacklistQuery(nameQuery, removeGuildId))
          .collation(CASE_INSENSITIVE_COLLATION)
          .lean(),
        Whitelist.findOne(nameQuery)
          .collation(CASE_INSENSITIVE_COLLATION)
          .lean(),
        Watchlist.findOne(nameQuery)
          .collation(CASE_INSENSITIVE_COLLATION)
          .lean(),
      ]);
      // The picker offers every blacklist entry the scope query matched,
      // preferred one first (current-guild server > other server > global).
      // Offering only the preferred entry shadowed same-named entries: an
      // owner could be locked out of removing their own global entry while
      // a server entry existed under the same name.
      const preferredBlack = pickPreferredListEntry(blackEntries, [name], {
        preferServerScope: true,
        preferredGuildId: removeGuildId,
      });
      const orderedBlackEntries = [
        ...(preferredBlack ? [preferredBlack] : []),
        ...blackEntries.filter((entry) => entry !== preferredBlack),
      ];

      // Collect all found entries
      const found = [
        ...orderedBlackEntries.map((entry) => ({ entry, type: 'black' })),
        whiteEntry ? { entry: whiteEntry, type: 'white' } : null,
        watchEntry ? { entry: watchEntry, type: 'watch' } : null,
      ].filter(Boolean);

      if (found.length === 0) {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          ...t('dialogue.remove.notFound', lang, { name }),
          lang,
        });
        return;
      }

      // Loaded before the delete, because afterwards the entry is gone and
      // the card still has to describe what it removed. One query feeds
      // both the alt rows (class icon + ilvl + CP) and the Server badge.
      const snapshotNames = [...new Set(
        found.flatMap(({ entry }) => [entry.name, ...(entry.allCharacters || [])]).filter(Boolean)
      )];
      let removeStatMap = new Map();
      try {
        const snapshots = await RosterSnapshot.find({ name: { $in: snapshotNames } })
          .collation(CASE_INSENSITIVE_COLLATION)
          .lean();
        removeStatMap = statMapFromRosterCharacters(snapshots);
      } catch (err) {
        console.warn('[list] Snapshot lookup for remove card failed (non-fatal):', err.message);
      }
      const removedWorld = resolveRosterWorld(found[0].entry, removeStatMap);

      // removeOne returns a structured outcome envelope so the caller
      // can render it as an embed.
      //
      // Outcome shapes:
      //   { ok: false, reason: 'legacy' | 'not-owner', entry, type }
      //   { ok: true, entry, type }
      const removeOne = async (entry, type) => {
        const { model, icon } = getListContext(type);
        const label = t(`dialogue.broadcast.list.${type}`, lang);

        if (!entry.addedByUserId) {
          // Pre-ownership entries have no owner to authorize the removal,
          // so officers/seniors act as the fallback custodians.
          if (!isOfficerOrSenior(interaction.user.id)) {
            return { ok: false, reason: 'legacy', entry, type, label, icon };
          }
        } else if (entry.addedByUserId !== interaction.user.id) {
          return { ok: false, reason: 'not-owner', entry, type, label, icon };
        }

        await model.deleteOne({ _id: entry._id });

        broadcastListChange('removed', entry, {
          type,
          guildId: interaction.guild?.id || '',
          requestedByDisplayName: getInteractionDisplayName(interaction),
          requestedByTag: interaction.user.tag,
        }, { onlyOwner: entry.scope === 'server' }).catch((err) => console.warn('[list] Broadcast failed:', err.message));

        return { ok: true, entry, type, label, icon };
      };

      const buildRemoveResultEmbed = (outcomes) => buildRemoveResultCard(outcomes, {
        name,
        lang,
        statMap: removeStatMap,
        world: removedWorld,
        removedBy: getInteractionDisplayName(interaction),
      });

      // Single entry · remove directly, render as embed.
      if (found.length === 1) {
        const outcome = await removeOne(found[0].entry, found[0].type);
        await editEmbed(interaction, buildRemoveResultEmbed([outcome]), { content: '' });
        return;
      }

      // Multiple entries · show selection buttons in an embed so the
      // picker matches the post-confirm result card. Custom IDs carry the
      // entry index: several same-type entries (e.g. a server and a global
      // blacklist under one name) must stay separately addressable.
      const buttonStyles = { black: ButtonStyle.Danger, white: ButtonStyle.Success, watch: ButtonStyle.Secondary };
      const buttons = [
        ...found.map((f, i) => {
          const label = t(`dialogue.broadcast.list.${f.type}`, lang);
          return new ButtonBuilder()
            .setCustomId(`remove_${i}`)
            .setLabel(t('remove.removeFrom', lang, { index: i + 1, label }))
            .setStyle(buttonStyles[f.type] || ButtonStyle.Secondary);
        }),
        new ButtonBuilder()
          .setCustomId('remove_all')
          .setLabel(t('remove.removeAll', lang, { index: found.length + 1 }))
          .setStyle(ButtonStyle.Secondary),
      ];
      // Discord caps a row at five components · longer pickers wrap onto
      // further rows instead of dropping entries.
      const rows = [];
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(...buttons.slice(i, i + 5)));
      }

      const listLines = found.map((f, i) => {
        const ctx = getListContext(f.type);
        // In the owner guild the scope query returns server entries from
        // every guild, so a foreign guild's id disambiguates same-tagged
        // local rows.
        const foreignGuildId = f.entry.scope === 'server'
          && f.entry.guildId && f.entry.guildId !== removeGuildId
          ? ` · ${f.entry.guildId}` : '';
        const scopeTag = f.entry.scope === 'server'
          ? ` \`[${t('dialogue.approval.scopeTag.local', lang)}${foreignGuildId}]\``
          : '';
        const reason = f.entry.reason ? ` *${truncateInlineText(f.entry.reason, 80)}*` : '';
        return `${i + 1}. ${ctx.icon} **${t(`dialogue.broadcast.list.${f.type}`, lang)}**${scopeTag}${reason}`;
      });
      const pickerEmbed = createArtistEmbed()
        .setTitle(`🔎 ${t('dialogue.remove.pickerTitle', lang, { name })}`)
        .setDescription(`${t('dialogue.remove.pickerDescription', lang, { name, count: found.length })}\n\n${listLines.join('\n')}`)
        .setColor(COLORS.info)
        .setFooter({ text: t('dialogue.remove.pickerFooter', lang) })
        .setTimestamp();

      await editEmbed(interaction, pickerEmbed, { content: '', components: rows });

      const reply = await interaction.fetchReply();
      const button = await reply.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => i.user.id === interaction.user.id,
        time: 30000,
      });

      let outcomes;
      if (button.customId === 'remove_all') {
        outcomes = await Promise.all(found.map((f) => removeOne(f.entry, f.type)));
      } else {
        const targetIndex = Number(button.customId.slice('remove_'.length));
        const target = found[targetIndex];
        outcomes = target
          ? [await removeOne(target.entry, target.type)]
          : [{ ok: false, reason: 'unknown-selection', entry: { name }, type: 'black', label: t('dialogue.remove.unknown', lang), icon: '⚠️' }];
      }

      await updateEmbed(button, buildRemoveResultEmbed(outcomes), {
        content: '',
        components: [],
      });
    } catch (err) {
      console.error('[list] ❌ Remove failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        ...t('dialogue.remove.failed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
    }
  }

  return { handleListRemoveCommand };
}
