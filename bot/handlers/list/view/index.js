import config from '../../../config.js';
import { connectDB } from '../../../db.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { getListContext } from '../helpers.js';
import {
  buildEvidenceEmbed,
  buildExpiredComponents,
  buildListPageEmbed,
  buildListViewComponents,
  buildTrustedListEmbed,
} from './ui.js';

const ITEMS_PER_PAGE = 10;

function resolveTypes(type, scopeFilter) {
  if (scopeFilter && type === 'all') return ['black'];
  return type === 'all' ? ['black', 'white', 'watch'] : [type];
}

function buildBlacklistViewQuery({ isOwnerGuild, scopeFilter, viewGuildId }) {
  if (isOwnerGuild && (!scopeFilter || scopeFilter === 'all')) return {};
  if (scopeFilter === 'global') {
    return { $or: [{ scope: 'global' }, { scope: { $exists: false } }] };
  }
  if (scopeFilter === 'server') {
    return isOwnerGuild
      ? { scope: 'server' }
      : { scope: 'server', guildId: viewGuildId };
  }
  return {
    $or: [
      { scope: 'global' },
      { scope: { $exists: false } },
      { scope: 'server', guildId: viewGuildId },
    ],
  };
}

async function loadListEntries({ isOwnerGuild, scopeFilter, type, viewGuildId }) {
  const allEntries = [];
  const types = resolveTypes(type, scopeFilter);

  for (const listType of types) {
    const { model, label, color, icon } = getListContext(listType);
    const query = listType === 'black' && viewGuildId
      ? buildBlacklistViewQuery({ isOwnerGuild, scopeFilter, viewGuildId })
      : {};
    const entries = await model.find(query).sort({ addedAt: -1 }).lean();
    for (const entry of entries) {
      allEntries.push({ ...entry, _listType: listType, _label: label, _color: color, _icon: icon });
    }
  }

  allEntries.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  return allEntries;
}

async function buildGuildNameCache({ allEntries, client, isOwnerGuild }) {
  const guildNameCache = new Map();
  if (!isOwnerGuild) return guildNameCache;

  const serverGuildIds = [...new Set(
    allEntries.filter((entry) => entry.scope === 'server' && entry.guildId).map((entry) => entry.guildId)
  )];
  await Promise.all(serverGuildIds.map(async (guildId) => {
    try {
      const guild = await client.guilds.fetch(guildId);
      guildNameCache.set(guildId, guild.name);
    } catch {
      guildNameCache.set(guildId, guildId);
    }
  }));
  return guildNameCache;
}

export function createViewHandlers({ client }) {
  async function handleListViewCommand(interaction) {
    if (!interaction.guild) {
      await interaction.reply({ content: '❌ This command can only be used in a server.', ephemeral: true });
      return;
    }

    const type = interaction.options.getString('type', true);
    const scopeFilter = interaction.options.getString('scope') || '';

    await interaction.deferReply();

    try {
      await connectDB();

      if (type === 'trusted') {
        const trustedEntries = await TrustedUser.find({}).sort({ addedAt: -1 }).lean();
        if (trustedEntries.length === 0) {
          await interaction.editReply({ content: '🛡️ Trusted list is empty.' });
          return;
        }
        await interaction.editReply({ embeds: [buildTrustedListEmbed(trustedEntries)] });
        return;
      }

      const viewGuildId = interaction.guild.id;
      const isOwnerGuild = viewGuildId === config.ownerGuildId;
      const allEntries = await loadListEntries({ isOwnerGuild, scopeFilter, type, viewGuildId });

      if (allEntries.length === 0) {
        await interaction.editReply({
          content: type === 'all'
            ? 'All lists are empty.'
            : `${getListContext(type).icon} ${getListContext(type).label} is empty.`,
        });
        return;
      }

      const guildNameCache = await buildGuildNameCache({ allEntries, client, isOwnerGuild });
      const totalPages = Math.ceil(allEntries.length / ITEMS_PER_PAGE);
      let currentPage = 0;

      const pageOptions = () => ({
        allEntries,
        client,
        currentType: type,
        getListContext,
        guildNameCache,
        isOwnerGuild,
        itemsPerPage: ITEMS_PER_PAGE,
        page: currentPage,
        totalPages,
      });
      const componentOptions = () => ({
        allEntries,
        itemsPerPage: ITEMS_PER_PAGE,
        page: currentPage,
        totalPages,
      });

      await interaction.editReply({
        embeds: [await buildListPageEmbed(pageOptions())],
        components: buildListViewComponents(componentOptions()),
      });

      const reply = await interaction.fetchReply();
      const collector = reply.createMessageComponentCollector({ time: 300000 });

      collector.on('collect', async (componentInteraction) => {
        if (componentInteraction.user.id !== interaction.user.id) {
          await componentInteraction.reply({ content: '⛔ Only the command user can navigate.', ephemeral: true });
          return;
        }

        if (componentInteraction.customId === 'listview_prev' || componentInteraction.customId === 'listview_next') {
          currentPage = componentInteraction.customId === 'listview_prev'
            ? Math.max(0, currentPage - 1)
            : Math.min(totalPages - 1, currentPage + 1);
          await componentInteraction.deferUpdate();
          await componentInteraction.editReply({
            embeds: [await buildListPageEmbed(pageOptions())],
            components: buildListViewComponents(componentOptions()),
          });
          return;
        }

        if (componentInteraction.customId === 'listview_evidence') {
          const index = parseInt(componentInteraction.values[0], 10);
          const entry = allEntries[index];
          if (!entry?.imageMessageId && !entry?.imageUrl) {
            await componentInteraction.reply({ content: 'No evidence image for this entry.', ephemeral: true });
            return;
          }

          const displayUrl = await resolveDisplayImageUrl(entry, client);
          const isOfficer = config.officerApproverIds.includes(componentInteraction.user.id)
            || config.seniorApproverIds.includes(componentInteraction.user.id);
          await componentInteraction.reply({
            embeds: [buildEvidenceEmbed(entry, displayUrl, { includeAddedBy: isOfficer })],
            ephemeral: true,
          });
        }
      });

      collector.on('end', async () => {
        await interaction.editReply({
          content: '⏱️ Session expired. Use `/la-list view` again to browse.',
          components: buildExpiredComponents(),
        }).catch(() => {});
      });
    } catch (err) {
      console.error('[list] View failed:', err.message);
      await interaction.editReply({ content: `⚠️ Failed to load list: \`${err.message}\`` });
    }
  }

  return { handleListViewCommand };
}
