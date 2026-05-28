/**
 * handlers/list/view/index.js
 * /la-list view: paginated list browser for blacklist / whitelist /
 * watchlist / trusted. Renders the embed via view/ui.js helpers and
 * wires the pagination buttons + evidence dropdowns.
 */

import config from '../../../config.js';
import { connectDB } from '../../../db.js';
import TrustedUser from '../../../models/TrustedUser.js';
import UserPreference from '../../../models/UserPreference.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editComponents,
  editEmbed,
  replyAlert,
  replyContent,
  replyEmbed,
} from '../../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
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

/**
 * Build the /la-list view handler bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   (used to refresh rehosted evidence URLs when the dropdown asks
 *   for an image that's past its CDN expiry)
 * @returns {{
 *   handleListViewCommand: Function,
 *   handleListViewPaginateButton: Function,
 *   handleListViewEvidenceSelect: Function,
 * }}
 */
export function createViewHandlers({ client }) {
  async function handleListViewCommand(interaction) {
    if (!interaction.guild) {
      await replyAlert(interaction, {
        severity: AlertSeverity.ERROR,
        title: 'Server-Only Command',
        description: 'This command can only be used inside a Discord server, not in DMs.',
      });
      return;
    }

    const type = interaction.options.getString('type', true);
    const scopeFilter = interaction.options.getString('scope') || '';

    await deferReply(interaction);

    try {
      await connectDB();
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

      if (type === 'trusted') {
        const trustedEntries = await TrustedUser.find({}).sort({ addedAt: -1 }).lean();
        if (trustedEntries.length === 0) {
          await editAlert(interaction, {
            severity: AlertSeverity.INFO,
            titleIcon: '🛡️',
            title: t('listView.trusted.emptyTitle', lang),
            description: t('listView.trusted.emptyDescription', lang),
            footer: t('listView.trusted.emptyFooter', lang),
          });
          return;
        }
        await editEmbed(interaction, buildTrustedListEmbed(trustedEntries, lang));
        return;
      }

      const viewGuildId = interaction.guild.id;
      const isOwnerGuild = viewGuildId === config.ownerGuildId;
      const allEntries = await loadListEntries({ isOwnerGuild, scopeFilter, type, viewGuildId });

      if (allEntries.length === 0) {
        const ctx = type === 'all' ? null : getListContext(type);
        await editAlert(interaction, {
          severity: AlertSeverity.INFO,
          titleIcon: ctx?.icon,
          title: type === 'all'
            ? t('listView.empty.allTitle', lang)
            : t('listView.empty.typedTitle', lang, { label: ctx.label }),
          description: type === 'all'
            ? t('listView.empty.allDescription', lang)
            : t('listView.empty.typedDescription', lang, { label: ctx.label }),
        });
        return;
      }

      const guildNameCache = await buildGuildNameCache({ allEntries, client, isOwnerGuild });
      const totalPages = Math.ceil(allEntries.length / ITEMS_PER_PAGE);
      let currentPage = 0;
      const evidenceUrlCache = new Map();

      const pageOptions = () => ({
        allEntries,
        client,
        currentType: type,
        evidenceUrlCache,
        getListContext,
        guildNameCache,
        isOwnerGuild,
        itemsPerPage: ITEMS_PER_PAGE,
        lang,
        page: currentPage,
        totalPages,
      });
      const componentOptions = () => ({
        allEntries,
        itemsPerPage: ITEMS_PER_PAGE,
        lang,
        page: currentPage,
        totalPages,
      });

      await editEmbed(interaction, await buildListPageEmbed(pageOptions()), {
        components: buildListViewComponents(componentOptions()),
      });

      const reply = await interaction.fetchReply();
      const collector = reply.createMessageComponentCollector({ time: 300000 });

      collector.on('collect', async (componentInteraction) => {
        if (componentInteraction.user.id !== interaction.user.id) {
          await replyAlert(componentInteraction, {
            severity: AlertSeverity.ERROR,
            title: 'Not Your Session',
            description: 'Only the command user can navigate this list view.',
          });
          return;
        }

        if (componentInteraction.customId === 'listview_prev' || componentInteraction.customId === 'listview_next') {
          currentPage = componentInteraction.customId === 'listview_prev'
            ? Math.max(0, currentPage - 1)
            : Math.min(totalPages - 1, currentPage + 1);
          await componentInteraction.deferUpdate();
          await editEmbed(componentInteraction, await buildListPageEmbed(pageOptions()), {
            components: buildListViewComponents(componentOptions()),
          });
          return;
        }

        if (componentInteraction.customId === 'listview_evidence') {
          const index = parseInt(componentInteraction.values[0], 10);
          const entry = allEntries[index];
          if (!entry?.imageMessageId && !entry?.imageUrl) {
            await replyContent(componentInteraction, t('listView.evidence.noImage', lang));
            return;
          }

          const displayUrl = await resolveDisplayImageUrl(entry, client);
          const isOfficer = config.officerApproverIds.includes(componentInteraction.user.id)
            || config.seniorApproverIds.includes(componentInteraction.user.id);
          await replyEmbed(componentInteraction, buildEvidenceEmbed(entry, displayUrl, { includeAddedBy: isOfficer, lang }));
        }
      });

      collector.on('end', async () => {
        await editComponents(interaction, buildExpiredComponents(lang)).catch(() => {});
      });
    } catch (err) {
      console.error('[list] View failed:', err.message);
      await editAlert(interaction, {
        severity: AlertSeverity.WARNING,
        title: 'View Failed',
        description: 'Could not load the list.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      });
    }
  }

  return { handleListViewCommand };
}
