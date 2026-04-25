import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import Watchlist from '../../models/Watchlist.js';
import GuildConfig from '../../models/GuildConfig.js';
import PendingApproval from '../../models/PendingApproval.js';
import TrustedUser from '../../models/TrustedUser.js';
import { getClassName } from '../../models/Class.js';
import {
  buildRosterCharacters,
  fetchNameSuggestions,
  fetchCharacterMeta,
  detectAltsViaStronghold,
} from '../../services/rosterService.js';
import {
  extractNamesFromImage,
  checkNamesAgainstLists,
  formatCheckResults,
} from '../../services/listCheckService.js';
import {
  normalizeCharacterName,
  getAddedByDisplay,
  getInteractionDisplayName,
} from '../../utils/names.js';
import { buildBlacklistQuery, getGuildConfig } from '../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { rehostImage, resolveDisplayImageUrl, refreshImageUrl } from '../../utils/imageRehost.js';
import {
  buildMultiaddTemplate,
  parseMultiaddFile,
  MULTIADD_MAX_ROWS,
} from '../../services/multiaddTemplateService.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
  buildListEditSuccessEmbed,
  buildListAddApprovalEmbed,
  getApproverRecipientIds,
  isRequesterAutoApprover,
  isOfficerOrSenior,
  getSeniorApproverIds,
  buildApprovalResultRow,
  buildApprovalProcessingRow,
} from './helpers.js';

const OFFICER_APPROVER_IDS = config.officerApproverIds;
const SENIOR_APPROVER_IDS = config.seniorApproverIds;

export function createViewHandlers({ client }) {

  async function handleListViewCommand(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const type = interaction.options.getString('type', true);
    const scopeFilter = interaction.options.getString('scope') || '';
    const ITEMS_PER_PAGE = 10;

    await interaction.deferReply();

    try {
      await connectDB();

      // Handle trusted list separately (different model/schema)
      if (type === 'trusted') {
        const trustedEntries = await TrustedUser.find({}).sort({ addedAt: -1 }).lean();
        if (trustedEntries.length === 0) {
          await interaction.editReply({ content: '🛡️ Trusted list is empty.' });
          return;
        }

        const lines = trustedEntries.map((e, i) => {
          const parts = [`🛡️ **${e.name}**`];
          if (e.reason) parts.push(e.reason);
          const date = e.addedAt ? `<t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>` : '';
          if (date) parts.push(date);
          return `${i + 1}. ${parts.join(' — ')}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ Trusted Users (${trustedEntries.length})`)
          .setDescription(lines.join('\n'))
          .setColor(0x57d6a1)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      // When scope filter is set, only include blacklist (scope only applies to blacklist)
      let types;
      if (scopeFilter && type === 'all') {
        types = ['black'];
      } else {
        types = type === 'all' ? ['black', 'white', 'watch'] : [type];
      }
      const allEntries = [];
      const viewGuildId = interaction.guild.id;
      const isOwnerGuild = viewGuildId === config.ownerGuildId;

      for (const t of types) {
        const { model, label, color, icon } = getListContext(t);

        // Blacklist: scope-aware query depending on who's viewing
        let query = {};
        if (t === 'black' && viewGuildId) {
          if (isOwnerGuild && (!scopeFilter || scopeFilter === 'all')) {
            // Owner server, no filter or "all" → see everything
            query = {};
          } else if (scopeFilter === 'global') {
            query = { $or: [{ scope: 'global' }, { scope: { $exists: false } }] };
          } else if (scopeFilter === 'server') {
            if (isOwnerGuild) {
              // Owner sees all server-scoped entries
              query = { scope: 'server' };
            } else {
              // Other servers see only their own
              query = { scope: 'server', guildId: viewGuildId };
            }
          } else {
            // Default for non-owner: global + own server entries
            query = { $or: [
              { scope: 'global' },
              { scope: { $exists: false } },
              { scope: 'server', guildId: viewGuildId },
            ] };
          }
        }

        const entries = await model.find(query).sort({ addedAt: -1 }).lean();
        for (const e of entries) {
          allEntries.push({ ...e, _listType: t, _label: label, _color: color, _icon: icon });
        }
      }

      if (allEntries.length === 0) {
        await interaction.editReply({ content: type === 'all' ? 'All lists are empty.' : `${getListContext(type).icon} ${getListContext(type).label} is empty.` });
        return;
      }

      // Sort all entries by addedAt (newest first)
      allEntries.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));

      // Resolve guild names for server-scoped entries (owner view shows which server)
      const guildNameCache = new Map();
      if (isOwnerGuild) {
        const serverGuildIds = [...new Set(
          allEntries.filter((e) => e.scope === 'server' && e.guildId).map((e) => e.guildId)
        )];
        await Promise.all(serverGuildIds.map(async (gid) => {
          try {
            const guild = await client.guilds.fetch(gid);
            guildNameCache.set(gid, guild.name);
          } catch {
            guildNameCache.set(gid, gid); // fallback to ID if can't resolve
          }
        }));
      }

      const totalPages = Math.ceil(allEntries.length / ITEMS_PER_PAGE);
      let currentPage = 0;

      async function buildPage(page) {
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);

        // Resolve fresh image URLs for the current page in parallel.
        // For rehosted entries (imageMessageId set) we fetch the evidence
        // message to get a freshly-signed URL — this is what makes 📎 link
        // open the actual image instead of navigating to the storage channel.
        // Legacy entries fall back to their stored (possibly expired) URL.
        // Max ~10 parallel fetches per page, completes in <1s typical.
        const freshUrls = await Promise.all(
          pageEntries.map(async (e) => {
            if (e.imageMessageId && e.imageChannelId) {
              const fresh = await refreshImageUrl(e.imageMessageId, e.imageChannelId, client);
              return fresh || ''; // empty string if refresh failed
            }
            return e.imageUrl || '';
          })
        );

        const lines = pageEntries.map((e, i) => {
          let scopeLabel = '';
          if (e.scope === 'server') {
            if (isOwnerGuild && e.guildId) {
              const gName = guildNameCache.get(e.guildId) || e.guildId;
              scopeLabel = ` (Local: ${gName})`;
            } else {
              scopeLabel = ' (Local)';
            }
          }
          const parts = [`${e._icon} **${e.name}**${scopeLabel}`];
          if (e.reason) parts.push(e.reason);
          if (e.raid) parts.push(`[${e.raid}]`);
          const date = e.addedAt ? `<t:${Math.floor(new Date(e.addedAt).getTime() / 1000)}:R>` : '';
          if (date) parts.push(date);
          // 📎 inline link points to the actual image — fresh URL for rehosted
          // entries, legacy URL for old entries. Click → preview image in
          // browser/Discord client (NOT navigate to evidence channel).
          const imgUrl = freshUrls[i];
          if (imgUrl) parts.push(`[📎](${imgUrl})`);
          return `${start + i + 1}. ${parts.join(' — ')}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(type === 'all' ? `All Lists (${allEntries.length})` : `${getListContext(type).icon} ${getListContext(type).label} (${allEntries.length})`)
          .setDescription(lines.join('\n'))
          .setColor(type === 'all' ? 0x5865f2 : getListContext(type).color)
          .setFooter({ text: `Page ${page + 1}/${totalPages}` })
          .setTimestamp();

        return embed;
      }

      function buildComponents(page) {
        const rows = [];

        // Navigation buttons
        const navRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('listview_prev')
            .setLabel('◀ Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('listview_next')
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages - 1),
        );
        rows.push(navRow);

        // Evidence dropdown for entries with images on current page.
        // Includes both legacy (imageUrl) and rehosted (imageMessageId) entries.
        const start = page * ITEMS_PER_PAGE;
        const pageEntries = allEntries.slice(start, start + ITEMS_PER_PAGE);
        const withImages = pageEntries.filter((e) => e.imageUrl || e.imageMessageId);

        if (withImages.length > 0) {
          const selectRow = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId('listview_evidence')
              .setPlaceholder('📎 View evidence for...')
              .addOptions(
                withImages.slice(0, 25).map((e, i) => ({
                  label: e.name,
                  description: (e.reason || 'No reason').slice(0, 100),
                  value: String(start + pageEntries.indexOf(e)),
                  emoji: e._icon,
                }))
              )
          );
          rows.push(selectRow);
        }

        return rows;
      }

      const components = buildComponents(0);

      await interaction.editReply({
        embeds: [await buildPage(0)],
        components,
      });


      const reply = await interaction.fetchReply();
      const collector = reply.createMessageComponentCollector({
        time: 300000,
      });

      collector.on('collect', async (i) => {
        if (i.user.id !== interaction.user.id) {
          await i.reply({ content: '⛔ Only the command user can navigate.', ephemeral: true });
          return;
        }

        if (i.customId === 'listview_prev') {
          currentPage = Math.max(0, currentPage - 1);
          // Defer update because buildPage now does up to 10 parallel API
          // calls to refresh evidence URLs — Discord requires acknowledgment
          // within 3s and we'd rather show a brief loader than time out.
          await i.deferUpdate();
          await i.editReply({ embeds: [await buildPage(currentPage)], components: buildComponents(currentPage) });
        } else if (i.customId === 'listview_next') {
          currentPage = Math.min(totalPages - 1, currentPage + 1);
          await i.deferUpdate();
          await i.editReply({ embeds: [await buildPage(currentPage)], components: buildComponents(currentPage) });
        } else if (i.customId === 'listview_evidence') {
          const idx = parseInt(i.values[0]);
          const entry = allEntries[idx];

          // Check if entry has ANY image source: rehosted or legacy
          const hasAnyImage = entry?.imageMessageId || entry?.imageUrl;
          if (!hasAnyImage) {
            await i.reply({ content: 'No evidence image for this entry.', ephemeral: true });
            return;
          }

          // Resolve fresh URL via rehost-aware helper. For rehosted entries
          // this fetches a fresh signed URL from the evidence channel; for
          // legacy entries it returns the (possibly expired) stored URL.
          const displayUrl = await resolveDisplayImageUrl(entry, client);

          const embed = new EmbedBuilder()
            .setTitle(`${entry._icon} ${entry.name}`)
            .addFields(
              { name: 'Reason', value: entry.reason || 'N/A', inline: true },
              { name: 'Raid', value: entry.raid || 'N/A', inline: true },
              { name: 'List', value: entry._label, inline: true },
            )
            .setColor(entry._color)
            .setTimestamp(entry.addedAt ? new Date(entry.addedAt) : undefined);

          if (displayUrl) {
            embed.setImage(displayUrl);
          } else {
            embed.addFields({
              name: '⚠️ Evidence',
              value: 'Image link expired or unavailable. Re-add evidence via `/list edit`.',
              inline: false,
            });
          }

          if (entry.logsUrl) {
            embed.addFields({ name: 'Logs', value: `[View Logs](${entry.logsUrl})`, inline: false });
          }

          // Show "Added by" only to officers/seniors (ephemeral = only they see it)
          const isOfficer = OFFICER_APPROVER_IDS.includes(i.user.id)
            || SENIOR_APPROVER_IDS.includes(i.user.id);
          if (isOfficer && entry.addedByDisplayName) {
            embed.addFields({ name: 'Added by', value: entry.addedByDisplayName, inline: true });
          }

          await i.reply({ embeds: [embed], ephemeral: true });
        }
      });

      collector.on('end', async () => {
        const disabledNav = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('listview_prev_disabled').setLabel('◀ Previous').setStyle(ButtonStyle.Secondary).setDisabled(true),
          new ButtonBuilder().setCustomId('listview_next_disabled').setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(true),
        );
        await interaction.editReply({
          content: '⏱️ Session expired. Use `/list view` again to browse.',
          components: [disabledNav],
        }).catch(() => {});
      });
    } catch (err) {
      console.error(`[list] View failed:`, err.message);
      await interaction.editReply({ content: `⚠️ Failed to load list: \`${err.message}\`` });
    }
  }

  return { handleListViewCommand };
}
