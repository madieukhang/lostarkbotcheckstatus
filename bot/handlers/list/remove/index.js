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
import { rosterUrl } from '../../../utils/rosterLink.js';
import { COLORS } from '../../../utils/ui.js';
import Blacklist from '../../../models/Blacklist.js';
import Whitelist from '../../../models/Whitelist.js';
import Watchlist from '../../../models/Watchlist.js';
import UserPreference from '../../../models/UserPreference.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildBlacklistQuery } from '../../../utils/scope.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editEmbed,
  updateEmbed,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { getListContext } from '../helpers.js';

/**
 * Build the /la-list remove handler bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 * @param {object} deps.services - shared services
 *   (broadcastListChange for the post-remove guild notification)
 * @returns {{handleListRemoveCommand: Function}}
 */
export function createRemoveHandlers({ client, services }) {
  const { broadcastListChange } = services;

  async function handleListRemoveCommand(interaction) {
    const rawName = interaction.options.getString('name', true).trim();
    const name = normalizeCharacterName(rawName);

    await deferReply(interaction);

    try {
      await connectDB();
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

      const removeGuildId = interaction.guild?.id || '';
      const nameQuery = buildNameRosterQuery(name);
      const [blackEntry, whiteEntry, watchEntry] = await Promise.all([
        Blacklist.findOne(buildBlacklistQuery(nameQuery, removeGuildId))
          .sort({ scope: -1 })
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Whitelist.findOne(nameQuery)
          .collation({ locale: 'en', strength: 2 })
          .lean(),
        Watchlist.findOne(nameQuery)
          .collation({ locale: 'en', strength: 2 })
          .lean(),
      ]);

      // Collect all found entries
      const found = [];
      if (blackEntry) found.push({ entry: blackEntry, type: 'black' });
      if (whiteEntry) found.push({ entry: whiteEntry, type: 'white' });
      if (watchEntry) found.push({ entry: watchEntry, type: 'watch' });

      if (found.length === 0) {
        await editAlert(interaction, {
          severity: AlertSeverity.WARNING,
          title: 'Not Found',
          description: `**${name}** is not in any list, so there's nothing to remove.`,
          footer: 'Use /la-list view to browse existing entries.',
        });
        return;
      }

      // removeOne returns a structured outcome envelope so the caller
      // can render it as an embed. The previous string-based return
      // produced plain content lines which lacked visual hierarchy
      // (no color, no inline scope tag, no allCharacters reference).
      //
      // Outcome shapes:
      //   { ok: false, reason: 'legacy' | 'not-owner', entry, type }
      //   { ok: true, entry, type }
      const removeOne = async (entry, type) => {
        const { model, label, icon } = getListContext(type);

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

      // Render N outcome envelopes as a single result embed. Color and
      // title icon follow the strongest outcome present (any failure
      // tints warning; otherwise the success-list-icon if just one
      // type, else generic success).
      const buildRemoveResultEmbed = (outcomes) => {
        const oks = outcomes.filter((o) => o.ok);
        const fails = outcomes.filter((o) => !o.ok);

        let color;
        let titleIcon;
        let title;
        if (fails.length > 0 && oks.length === 0) {
          color = 0xfee75c;
          titleIcon = '⚠️';
          title = `Removal blocked · ${name}`;
        } else if (oks.length === 1 && fails.length === 0) {
          color = oks[0].type === 'black' ? 0xed4245 : oks[0].type === 'white' ? 0x57f287 : 0xfee75c;
          titleIcon = oks[0].icon;
          title = `Removed from ${oks[0].label} · ${name}`;
        } else if (oks.length > 1) {
          color = 0x57f287;
          titleIcon = '🗑️';
          title = `Removed from ${oks.length} list(s) · ${name}`;
        } else {
          color = 0xfee75c;
          titleIcon = '⚠️';
          title = `Mixed result · ${name}`;
        }

        const sections = [];
        if (oks.length > 0) {
          const removedLines = oks.map((o) => {
            const scopeTag = o.entry.scope === 'server' ? ' `[Local]`' : '';
            const reason = o.entry.reason ? ` *${(o.entry.reason || '').slice(0, 80)}${o.entry.reason.length > 80 ? '...' : ''}*` : '';
            return `${o.icon} **${o.label}**${scopeTag}${reason}`;
          });
          sections.push(`✅ **Successfully removed:**\n${removedLines.join('\n')}`);
        }
        if (fails.length > 0) {
          const failLines = fails.map((o) => {
            if (o.reason === 'legacy') {
              return `⚠️ **${o.label}**: Legacy entry (no owner metadata). Use /la-list edit to remove.`;
            }
            const owner = o.entry.addedByTag || o.entry.addedByUserId;
            return `⛔ **${o.label}**: Only **${owner}** (who added it) can remove this entry.`;
          });
          sections.push(`🚫 **Could not remove:**\n${failLines.join('\n')}`);
        }

        // Roster preview helps verify "did I remove the right entry?"
        // Scan all entries (oks + fails) for allCharacters; first one
        // with > 1 char wins (entries usually share the same roster).
        const sourceEntry = (outcomes.find((o) => Array.isArray(o.entry.allCharacters) && o.entry.allCharacters.length > 1))?.entry;
        if (sourceEntry) {
          const others = (sourceEntry.allCharacters || []).filter(
            (n) => String(n).toLowerCase() !== String(sourceEntry.name).toLowerCase()
          );
          if (others.length > 0) {
            const visible = others.slice(0, 6);
            const linked = visible.map((n) => `[${n}](${rosterUrl(n)})`);
            const tail = others.length > visible.length ? ` *+${others.length - visible.length} more*` : '';
            sections.push(`🧬 **Tracked alts on this entry (${others.length}):**\n${linked.join(', ')}${tail}`);
          }
        }

        return createArtistEmbed()
          .setTitle(`${titleIcon} ${title}`)
          .setDescription(sections.join('\n\n').slice(0, 4096))
          .setColor(color)
          .setFooter({
            text: oks.length > 0
              ? 'Use /la-list view to confirm the removal landed.'
              : 'Use /la-list view to inspect the entry; /la-list edit to modify legacy entries.',
          })
          .setTimestamp();
      };

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
          const { label } = getListContext(f.type);
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
        const scopeTag = f.entry.scope === 'server' ? ' `[Local]`' : '';
        const reason = f.entry.reason ? ` *${(f.entry.reason || '').slice(0, 80)}${f.entry.reason.length > 80 ? '...' : ''}*` : '';
        return `${i + 1}. ${ctx.icon} **${ctx.label}**${scopeTag}${reason}`;
      });
      const pickerEmbed = createArtistEmbed()
        .setTitle(`🔎 Found · ${name}`)
        .setDescription(
          `**${name}** is in ${found.length} list(s). Pick which to remove:\n\n` +
          listLines.join('\n')
        )
        .setColor(COLORS.info)
        .setFooter({ text: '30s timeout · only you can act on this picker.' })
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
          : [{ ok: false, reason: 'unknown-selection', entry: { name }, type: 'black', label: 'unknown', icon: '⚠️' }];
      }

      await updateEmbed(button, buildRemoveResultEmbed(outcomes), {
        content: '',
        components: [],
      });
      return;
    } catch (err) {
      console.error('[list] ❌ Remove failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'Remove Failed',
        description: 'Could not remove the entry.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  return { handleListRemoveCommand };
}
