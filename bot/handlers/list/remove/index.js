/**
 * handlers/list/remove/index.js
 * /la-list remove: officer/senior-only entry to delete a list entry.
 * Shows a multi-list confirm picker when the name exists on more
 * than one list, then removes the chosen one and broadcasts the
 * change.
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
  renderTrackedAltsField,
  resolveRosterWorld,
  statMapFromRosterCharacters,
} from '../trackedAltsRender.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import UserPreference from '../../../models/UserPreference.js';
import { normalizeCharacterName, normalizeNameKey } from '../../../utils/names.js';
import { buildBlacklistQuery } from '../../../utils/scope.js';
import {
  buildNameRosterQuery,
  pickPreferredListEntry,
} from '../../../utils/listEntryMap.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editEmbed,
  updateEmbed,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t, tPick } from '../../../services/i18n/index.js';
import { getListContext } from '../helpers.js';

const REMOVE_COLOR_BY_TYPE = {
  black: 0xed4245,
  white: 0x57f287,
  watch: 0xfee75c,
};

const REMOVE_RESULT_PRESENTATIONS = [
  {
    matches: ({ oks, fails }) => fails.length > 0 && oks.length === 0,
    resolve: ({ name, lang }) => ({
      color: 0xfee75c,
      titleIcon: '⚠️',
      title: t('dialogue.remove.titles.blocked', lang, { name }),
    }),
  },
  {
    matches: ({ oks, fails }) => oks.length === 1 && fails.length === 0,
    resolve: ({ oks, name, lang }) => ({
      color: REMOVE_COLOR_BY_TYPE[oks[0].type] || 0xfee75c,
      titleIcon: oks[0].icon,
      title: t('dialogue.remove.titles.one', lang, { list: oks[0].label, name }),
    }),
  },
  {
    matches: ({ oks }) => oks.length > 1,
    resolve: ({ oks, name, lang }) => ({
      color: 0x57f287,
      titleIcon: '🗑️',
      title: t('dialogue.remove.titles.many', lang, { count: oks.length, name }),
    }),
  },
  {
    matches: () => true,
    resolve: ({ name, lang }) => ({
      color: 0xfee75c,
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
 * when, neither of which the old card carried at all.
 *
 * Color and title icon follow the strongest outcome present · any failure
 * tints warning, otherwise the list icon when a single type was removed.
 *
 * @param {Array<{ok: boolean, entry: object, type: string, label: string, icon: string, reason?: string}>} outcomes
 * @param {object} options
 * @param {string} options.name - the character name that was searched
 * @param {string} options.lang - locale for every label
 * @param {Map<string, object>} [options.statMap] - roster snapshots, for
 *   the alt rows' class icon, ilvl and CP
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

  // A single removal gets its reason as a field of its own, at full width
  // and untruncated. After this card the reason is gone, so an
  // 80-character crop is a real loss · with two or more lists the
  // per-line crop stays, because there is no one reason to lift out.
  const soleRemoval = oks.length === 1 ? oks[0].entry : null;
  const soleReason = String(soleRemoval?.reason || '').trim();

  const sections = [];
  if (oks.length > 0) {
    const removedLines = oks.map((o) => {
      const scopeTag = o.entry.scope === 'server' ? ` \`[${t('dialogue.approval.scopeTag.local', lang)}]\`` : '';
      const reason = !soleRemoval && o.entry.reason
        ? ` *${(o.entry.reason || '').slice(0, 80)}${o.entry.reason.length > 80 ? '...' : ''}*`
        : '';
      return `${o.icon} **${o.label}**${scopeTag}${reason}`;
    });
    sections.push({
      name: `✅ ${t('dialogue.remove.successSection', lang)}`,
      value: removedLines.join('\n').slice(0, 1024),
      inline: false,
    });
  }
  if (fails.length > 0) {
    const failLines = fails.map((o) => {
      if (o.reason === 'legacy') {
        return `⚠️ ${t('dialogue.remove.legacy', lang, { list: o.label })}`;
      }
      const owner = o.entry.addedByTag || o.entry.addedByUserId;
      return `⛔ ${t('dialogue.remove.ownerOnly', lang, { list: o.label, owner })}`;
    });
    sections.push({
      name: `🚫 ${t('dialogue.remove.failedSection', lang)}`,
      value: failLines.join('\n').slice(0, 1024),
      inline: false,
    });
  }

  // Roster preview identifies the removal target. Scan all entries
  // (successes and failures) for allCharacters; the first one with > 1
  // char wins, since entries usually share the same roster. Rendered
  // through the shared renderer so the rows carry a class icon, ilvl and
  // CP like every other character list · they used to be bare links.
  const sourceEntry = outcomes.find(
    (o) => Array.isArray(o.entry.allCharacters) && o.entry.allCharacters.length > 1
  )?.entry;
  const altsField = sourceEntry
    ? renderTrackedAltsField({
      names: sourceEntry.allCharacters,
      primaryName: sourceEntry.name,
      statMap,
      // The renderer appends its own "(N)", so the label must not carry one.
      label: `🧬 ${t('dialogue.remove.trackedAlts', lang)}`,
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
    ...sections,
    soleReason ? {
      name: `📝 ${t('dialogue.remove.removedReason', lang)}`,
      value: soleReason.slice(0, 1024),
      inline: false,
    } : null,
    ...auditFields,
    altsField,
  ].filter(Boolean);

  return createArtistEmbed(lang)
    .setTitle(`${titleIcon} ${title}`)
    .setDescription(tPick(`dialogue.remove.${soleReason ? 'line' : 'lineNoReason'}`, lang))
    .addFields(fields)
    .setColor(color)
    .setFooter({
      text: oks.length > 0
        ? t('dialogue.remove.footerReadd', lang, { name })
        : t('dialogue.remove.footerBlocked', lang),
    })
    .setTimestamp();
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
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Whitelist.findOne(nameQuery)
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Watchlist.findOne(nameQuery)
          .collation({ locale: 'en', strength: 2 })
          .lean(),
      ]);
      const blackEntry = pickPreferredListEntry(blackEntries, [name], {
        preferServerScope: true,
        preferredGuildId: removeGuildId,
      });

      // Collect all found entries
      const found = [
        blackEntry ? { entry: blackEntry, type: 'black' } : null,
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
          .collation({ locale: 'en', strength: 2 })
          .lean();
        removeStatMap = statMapFromRosterCharacters(snapshots);
      } catch (err) {
        console.warn('[list] Snapshot lookup for remove card failed (non-fatal):', err.message);
      }
      const removedWorld = resolveRosterWorld(found[0].entry, removeStatMap);

      // removeOne returns a structured outcome envelope so the caller
      // can render it as an embed. The previous string-based return
      // produced plain content lines which lacked visual hierarchy
      // (no color, no inline scope tag, no allCharacters reference).
      //
      // Outcome shapes:
      //   { ok: false, reason: 'legacy' | 'not-owner', entry, type }
      //   { ok: true, entry, type }
      const removeOne = async (entry, type) => {
        const { model, icon } = getListContext(type);
        const label = t(`dialogue.broadcast.list.${type}`, lang);

        if (!entry.addedByUserId) {
          return { ok: false, reason: 'legacy', entry, type, label, icon };
        }
        if (entry.addedByUserId !== interaction.user.id) {
          return { ok: false, reason: 'not-owner', entry, type, label, icon };
        }

        await model.deleteOne({ _id: entry._id });

        broadcastListChange('removed', entry, {
          type,
          guildId: interaction.guild?.id || '',
          requestedByDisplayName: interaction.member?.displayName || interaction.user.username,
          requestedByTag: interaction.user.tag,
        }, { onlyOwner: entry.scope === 'server' }).catch((err) => console.warn('[list] Broadcast failed:', err.message));

        return { ok: true, entry, type, label, icon };
      };

      const buildRemoveResultEmbed = (outcomes) => buildRemoveResultCard(outcomes, {
        name,
        lang,
        statMap: removeStatMap,
        world: removedWorld,
        removedBy: interaction.member?.displayName || interaction.user.username,
      });

      // Single entry · remove directly, render as embed.
      if (found.length === 1) {
        const outcome = await removeOne(found[0].entry, found[0].type);
        await editEmbed(interaction, buildRemoveResultEmbed([outcome]), { content: '' });
        return;
      }

      // Multiple entries · show selection buttons. Promote the prior
      // plain-text "Found X in Y" line into an embed so the picker
      // dialog matches the post-confirm result card visually.
      const buttonStyles = { black: ButtonStyle.Danger, white: ButtonStyle.Success, watch: ButtonStyle.Secondary };
      const row = new ActionRowBuilder().addComponents(
        ...found.map((f, i) => {
          const label = t(`dialogue.broadcast.list.${f.type}`, lang);
          return new ButtonBuilder()
            .setCustomId(`remove_${f.type}`)
            .setLabel(t('remove.removeFrom', lang, { index: i + 1, label }))
            .setStyle(buttonStyles[f.type] || ButtonStyle.Secondary);
        }),
        new ButtonBuilder()
          .setCustomId('remove_all')
          .setLabel(t('remove.removeAll', lang, { index: found.length + 1 }))
          .setStyle(ButtonStyle.Secondary)
      );

      const listLines = found.map((f, i) => {
        const ctx = getListContext(f.type);
        const scopeTag = f.entry.scope === 'server' ? ` \`[${t('dialogue.approval.scopeTag.local', lang)}]\`` : '';
        const reason = f.entry.reason ? ` *${(f.entry.reason || '').slice(0, 80)}${f.entry.reason.length > 80 ? '...' : ''}*` : '';
        return `${i + 1}. ${ctx.icon} **${t(`dialogue.broadcast.list.${f.type}`, lang)}**${scopeTag}${reason}`;
      });
      const pickerEmbed = createArtistEmbed(lang)
        .setTitle(`🔎 ${t('dialogue.remove.pickerTitle', lang, { name })}`)
        .setDescription(`${t('dialogue.remove.pickerDescription', lang, { name, count: found.length })}\n\n${listLines.join('\n')}`)
        .setColor(COLORS.info)
        .setFooter({ text: t('dialogue.remove.pickerFooter', lang) })
        .setTimestamp();

      await editEmbed(interaction, pickerEmbed, { content: '', components: [row] });

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
        const target = found.find((f) => button.customId === `remove_${f.type}`);
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
