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
  replyEmbed,
  replyNotice,
} from '../../../utils/interactionReplies.js';
import {
  getCachedUserLanguage,
  getUserLanguage,
  t,
} from '../../../services/i18n/index.js';
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

export async function loadListEntries(
  { isOwnerGuild, scopeFilter, type, viewGuildId },
  { resolveListContext = getListContext } = {}
) {
  const types = resolveTypes(type, scopeFilter);

  const entryGroups = await Promise.all(types.map(async (listType) => {
    const { model, label, color, icon } = resolveListContext(listType);
    const query = listType === 'black' && viewGuildId
      ? buildBlacklistViewQuery({ isOwnerGuild, scopeFilter, viewGuildId })
      : {};
    const entries = await model.find(query).sort({ addedAt: -1 }).lean();
    return entries.map((entry) => ({
      ...entry,
      _listType: listType,
      _label: label,
      _color: color,
      _icon: icon,
    }));
  }));

  const allEntries = entryGroups.flat();
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
      await deferReply(interaction, { ephemeral: true });
      const lang = getCachedUserLanguage(interaction.user.id);
      await editAlert(interaction, {
        severity: AlertSeverity.ERROR,
        ...t('dialogue.common.serverOnly', lang),
        lang,
      });
      return;
    }

    await deferReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

    const type = interaction.options.getString('type', true);
    const scopeFilter = interaction.options.getString('scope') || '';

    try {
      await connectDB();

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
          const clickerLang = await getUserLanguage(componentInteraction.user.id, { UserPreferenceModel: UserPreference });
          await replyAlert(componentInteraction, {
            severity: AlertSeverity.ERROR,
            ...t('dialogue.listView.session', clickerLang),
            lang: clickerLang,
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
            await replyNotice(componentInteraction, t('listView.evidence.noImage', lang), {
              severity: AlertSeverity.WARNING,
              lang,
            });
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
        ...t('dialogue.listView.failed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      });
    }
  }

  return { handleListViewCommand };
}
