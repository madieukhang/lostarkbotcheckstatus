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
import { createLatestOnlyQueue } from '../../../utils/async.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { AlertSeverity } from '../../../utils/alertEmbed.js';
import {
  deferReply,
  editAlert,
  editComponents,
  editEmbed,
  replyAlert,
  replyEmbed,
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
import { loadListViewStatMap } from './pageData.js';

const ITEMS_PER_PAGE = 10;

function resolveTypes(type, scopeFilter) {
  if (scopeFilter && type === 'all') return ['black'];
  return type === 'all' ? ['black', 'white', 'watch'] : [type];
}

export function buildBlacklistViewQuery(context) {
  const { isOwnerGuild, scopeFilter, viewGuildId } = context;
  const rules = [
    {
      matches: () => isOwnerGuild && (!scopeFilter || scopeFilter === 'all'),
      build: () => ({}),
    },
    {
      matches: () => scopeFilter === 'global',
      build: () => ({ $or: [{ scope: 'global' }, { scope: { $exists: false } }] }),
    },
    {
      matches: () => scopeFilter === 'server',
      build: () => isOwnerGuild
        ? { scope: 'server' }
        : { scope: 'server', guildId: viewGuildId },
    },
    {
      matches: () => true,
      build: () => ({
        $or: [
          { scope: 'global' },
          { scope: { $exists: false } },
          { scope: 'server', guildId: viewGuildId },
        ],
      }),
    },
  ];
  return rules.find(({ matches }) => matches()).build();
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

function seedGuildNameCache({ allEntries, client, isOwnerGuild, guildNameCache = new Map() }) {
  if (!isOwnerGuild) return guildNameCache;
  for (const entry of allEntries) {
    if (entry.scope !== 'server' || !entry.guildId || guildNameCache.has(entry.guildId)) continue;
    const cachedGuild = client?.guilds?.cache?.get?.(entry.guildId);
    if (cachedGuild?.name) guildNameCache.set(entry.guildId, cachedGuild.name);
  }
  return guildNameCache;
}

/**
 * Build the /la-list view handler bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   (used to refresh rehosted evidence URLs when the dropdown asks
 *   for an image that's past its CDN expiry)
 * @returns {{handleListViewCommand: Function}}
 */
export function createViewHandlers({
  client,
  connectDatabase = connectDB,
  loadEntries = loadListEntries,
  getLanguage = getUserLanguage,
  loadStatMap = loadListViewStatMap,
  now = Date.now,
} = {}) {
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

    const startedAt = Number(now());
    await deferReply(interaction);
    const acknowledgedAt = Number(now());
    let lang = getCachedUserLanguage(interaction.user.id);
    const type = interaction.options.getString('type', true);
    const scopeFilter = interaction.options.getString('scope') || '';

    try {
      const [resolvedLang] = await Promise.all([
        getLanguage(interaction.user.id, { UserPreferenceModel: UserPreference }),
        connectDatabase(),
      ]);
      lang = resolvedLang || lang;

      if (type === 'trusted') {
        const [trustedEntries, statMap] = await Promise.all([
          TrustedUser.find({}).sort({ addedAt: -1 }).lean(),
          loadStatMap(),
        ]);
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
        await editEmbed(interaction, buildTrustedListEmbed(trustedEntries, lang, statMap));
        console.log(
          `[list-view] rendered type=trusted entries=${trustedEntries.length} snapshots=${statMap.size} ackMs=${acknowledgedAt - startedAt} openMs=${Number(now()) - startedAt}`
        );
        return;
      }

      const viewGuildId = interaction.guild.id;
      const isOwnerGuild = viewGuildId === config.ownerGuildId;
      let [allEntries, statMap] = await Promise.all([
        loadEntries({ isOwnerGuild, scopeFilter, type, viewGuildId }),
        loadStatMap(),
      ]);

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

      const guildNameCache = seedGuildNameCache({ allEntries, client, isOwnerGuild });
      let totalPages = Math.max(1, Math.ceil(allEntries.length / ITEMS_PER_PAGE));
      let currentPage = 0;
      let refreshPromise = null;

      const refreshEntries = () => {
        if (refreshPromise) return refreshPromise;

        refreshPromise = (async () => {
          const [nextEntries, nextStatMap] = await Promise.all([
            loadEntries({ isOwnerGuild, scopeFilter, type, viewGuildId }),
            loadStatMap(),
          ]);
          allEntries = nextEntries;
          statMap = nextStatMap;
          totalPages = Math.max(1, Math.ceil(allEntries.length / ITEMS_PER_PAGE));
          currentPage = Math.min(currentPage, totalPages - 1);
          seedGuildNameCache({ allEntries, client, isOwnerGuild, guildNameCache });
          return true;
        })().finally(() => {
          refreshPromise = null;
        });
        return refreshPromise;
      };

      const pageOptions = () => ({
        allEntries,
        currentType: type,
        getListContext,
        guildNameCache,
        isOwnerGuild,
        itemsPerPage: ITEMS_PER_PAGE,
        lang,
        page: currentPage,
        statMap,
      });
      const componentOptions = () => ({
        allEntries,
        itemsPerPage: ITEMS_PER_PAGE,
        lang,
        page: currentPage,
        totalPages,
      });

      const firstRenderStartedAt = Number(now());
      const messageFromEdit = await editEmbed(interaction, buildListPageEmbed(pageOptions()), {
        components: buildListViewComponents(componentOptions()),
      });
      console.log(
        `[list-view] rendered type=${type} entries=${allEntries.length} snapshots=${statMap.size} ackMs=${acknowledgedAt - startedAt} firstRenderMs=${Number(now()) - firstRenderStartedAt} openMs=${Number(now()) - startedAt}`
      );

      let collectorEnded = false;
      const renderQueue = createLatestOnlyQueue(async () => {
        if (collectorEnded) return;
        await editEmbed(interaction, buildListPageEmbed(pageOptions()), {
          components: buildListViewComponents(componentOptions()),
        });
      }, {
        onError: (err, labels) => {
          console.warn(
            `[list-view] ${labels.join('+') || 'update'} render failed:`,
            err.message,
          );
        },
      });

      const reply = messageFromEdit?.createMessageComponentCollector
        ? messageFromEdit
        : await interaction.fetchReply();
      const collector = reply.createMessageComponentCollector({ time: 300000 });

      collector.on('collect', async (componentInteraction) => {
        if (componentInteraction.user.id !== interaction.user.id) {
          const clickerLang = await getLanguage(componentInteraction.user.id, { UserPreferenceModel: UserPreference });
          await replyAlert(componentInteraction, {
            severity: AlertSeverity.ERROR,
            ...t('dialogue.listView.session', clickerLang),
            lang: clickerLang,
          });
          return;
        }

        const isPrevious = componentInteraction.customId === 'listview_prev';
        const isNext = componentInteraction.customId === 'listview_next';
        const isRefresh = componentInteraction.customId === 'listview_refresh';
        if (isPrevious || isNext || isRefresh) {
          await componentInteraction.deferUpdate();
          if (isRefresh) {
            await refreshEntries().catch((err) => {
              console.warn('[list] Live view refresh failed:', err.message);
            });
          }
          if (isPrevious) currentPage = Math.max(0, currentPage - 1);
          if (isNext) currentPage = Math.min(totalPages - 1, currentPage + 1);
          await renderQueue.request(isRefresh ? 'refresh' : 'pagination');
          return;
        }

        if (componentInteraction.customId === 'listview_evidence') {
          const index = parseInt(componentInteraction.values[0], 10);
          const entry = allEntries[index];
          // An entry without a screenshot still has a reason, a raid and
          // its tracked alts · the card renders those and says the
          // evidence is missing, which the old early return replaced
          // with a bare "no image" notice and nothing else.
          const displayUrl = entry?.imageMessageId || entry?.imageUrl
            ? await resolveDisplayImageUrl(entry, client)
            : '';
          const isOfficer = config.officerApproverIds.includes(componentInteraction.user.id)
            || config.seniorApproverIds.includes(componentInteraction.user.id);
          await replyEmbed(componentInteraction, buildEvidenceEmbed(entry, displayUrl, {
            includeAddedBy: isOfficer,
            lang,
            statMap,
          }));
        }
      });

      collector.on('end', async () => {
        collectorEnded = true;
        await renderQueue.flush();
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
