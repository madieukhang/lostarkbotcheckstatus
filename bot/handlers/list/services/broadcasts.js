/**
 * handlers/list/services/broadcasts.js
 * Cross-guild broadcast helpers · posts list-change notifications to
 * the per-guild notify channel (configured via /la-setup config action:set-notify-channel
 * or LIST_NOTIFY_CHANNEL_IDS env fallback). Also exports the tracked-
 * alts field builder and roster stat-record merge helpers reused by
 * the multiadd reject/summary embeds.
 */

import config from '../../../config.js';
import GuildConfig from '../../../models/GuildConfig.js';
import RosterSnapshot from '../../../models/RosterSnapshot.js';
import { getClassEmoji, getClassName } from '../../../models/Class.js';
import { buildRosterCharacters } from '../../../services/roster/buildRosterCharacters.js';
import { upsertRosterSnapshots } from '../../../services/roster/rosterSnapshots.js';
import { getGuildLanguage, t } from '../../../services/i18n/index.js';
import { rosterUrl } from '../../../utils/rosterLink.js';
import { COLORS, ICONS, relativeTime } from '../../../utils/ui.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';
import { getListContext, listTypeIcon } from '../helpers.js';
import { buildBroadcastEvidenceComponents } from '../evidence/broadcastButton.js';
import {
  formatAltLine,
  renderTrackedAltsField,
} from '../trackedAltsRender.js';

const ACTION_VERB = Object.freeze({
  added:   'added to',
  removed: 'removed from',
  edited:  'edited in',
  // 'enriched' uses a bespoke headline (see broadcastListChange) that names the
  // new-alt count instead of the generic "was <verb> <list>" phrasing; the verb
  // here only feeds the card title ("List enriched broadcast").
  enriched: 'enriched',
});

function normalizeNameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function parseItemLevel(value) {
  const parsed = parseFloat(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeCombatScore(value) {
  const text = String(value || '').trim();
  return text && text !== '?' ? text : '';
}

function normalizeRosterStatRecord(record) {
  const name = String(record?.name || '').trim();
  if (!name) return null;
  return {
    name,
    classId: String(record?.classId || '').trim(),
    className: String(record?.className || '').trim(),
    itemLevel: parseItemLevel(record?.itemLevel),
    combatScore: normalizeCombatScore(record?.combatScore),
  };
}

export function mergeRosterStatRecords(records = [], baseMap = new Map()) {
  for (const record of records || []) {
    const normalized = normalizeRosterStatRecord(record);
    if (!normalized) continue;
    baseMap.set(normalizeNameKey(normalized.name), normalized);
  }
  return baseMap;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Merge cached + caller-provided roster stats and, when any tracked name is
 * still missing, perform one bounded roster read to self-heal old entries.
 * The hydrated roster is persisted so edit/remove broadcasts do not pay this
 * network cost again.
 */
export async function hydrateBroadcastStatMap({
  entry,
  initialRecords = [],
  buildRosterCharactersFn = buildRosterCharacters,
  upsertRosterSnapshotsFn = upsertRosterSnapshots,
  timeoutMs = 8_000,
}) {
  const statMap = mergeRosterStatRecords(initialRecords);
  const names = [...new Set([
    entry?.name,
    ...(Array.isArray(entry?.allCharacters) ? entry.allCharacters : []),
  ].filter(Boolean))];
  const isComplete = names.every((name) => statMap.has(normalizeNameKey(name)));
  if (isComplete || !entry?.name) return statMap;

  try {
    const result = await withTimeout(
      buildRosterCharactersFn(entry.name, { hiddenRosterFallback: true, viaWorker: true }),
      timeoutMs,
    );
    const hydrated = Array.isArray(result?.rosterCharacters)
      ? result.rosterCharacters
      : [];
    if (result?.hasValidRoster && hydrated.length > 0) {
      mergeRosterStatRecords(hydrated, statMap);
      await upsertRosterSnapshotsFn(hydrated, entry.name);
    }
  } catch (err) {
    console.warn('[list] Broadcast roster hydration failed (non-fatal):', err.message);
  }

  return statMap;
}

function getBroadcastClassName(record) {
  if (!record) return '';
  return record.className || (record.classId ? getClassName(record.classId) : '');
}

// formatBroadcastCharacterLine + buildTrackedAltsField are kept as thin
// wrappers around the shared renderer in handlers/list/trackedAltsRender.js
// so the broadcast-specific public API (which tests import) stays stable
// while the actual rendering logic lives in one place. Numbering changed
// from "1." plain to "**1.**" bold to match the shared renderer's
// formatting · cross-server broadcasts now read identically to the
// /la-list view evidence detail card.

export const formatBroadcastCharacterLine = formatAltLine;

export function buildTrackedAltsField(entry, statMap = new Map(), options = {}) {
  return renderTrackedAltsField({
    names: entry?.allCharacters,
    primaryName: entry?.name,
    statMap,
    ...options,
  });
}

export async function sendEmbedToChannels({
  client,
  channelIds,
  embed,
  components = [],
  buildPayload,
  logLabel = '[list broadcast]',
  logger = console,
}) {
  await Promise.all(
    [...(channelIds || [])].map(async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.isTextBased()) {
          const messagePayload = typeof buildPayload === 'function'
            ? await buildPayload({ channel, channelId })
            : {
                embeds: [embed],
                ...(components.length > 0 ? { components } : {}),
              };
          await channel.send(messagePayload);
        }
      } catch (err) {
        logger.warn?.(`${logLabel} channel ${channelId} failed: ${err.message}`);
      }
    })
  );
}

/**
 * Build the broadcast service bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   used to resolve the configured notify channels and post the
 *   change embed.
 * @returns {{
 *   broadcastListChange: Function,
 *   resolveBroadcastChannels: Function,
 *   broadcastBulkAdd: Function,
 * }}
 */
export function createBroadcastServices({
  client,
  buildRosterCharactersFn = buildRosterCharacters,
  upsertRosterSnapshotsFn = upsertRosterSnapshots,
}) {
  async function broadcastListChange(action, entry, payload, options = {}) {
    const {
      onlyOwner = false,
      displayUrl: preResolvedUrl,
      rosterCharacters = [],
      newAltNames = [],
    } = options;
    const isEnrich = action === 'enriched';
    const { color, icon } = getListContext(payload.type);
    const rosterLink = rosterUrl(entry.name);

    // RosterSnapshot enrichment for class icon + ilvl + CP. Best-effort:
    // if /la-roster has queried this name before, the broadcast carries
    // the same rich vocabulary as the v0.5.67 OCR check / scan cards.
    // Otherwise fall back to the older name-only headline.
    const allChars = Array.isArray(entry.allCharacters) ? entry.allCharacters : [];
    const lookupNames = [...new Set([entry.name, ...allChars].filter(Boolean))];
    let snapshots = [];
    try {
      snapshots = await RosterSnapshot.find({ name: { $in: lookupNames } })
        .collation({ locale: 'en', strength: 2 })
        .lean();
    } catch (err) {
      console.warn('[list] Snapshot lookup for broadcast failed (non-fatal):', err.message);
    }
    const statMap = await hydrateBroadcastStatMap({
      entry,
      initialRecords: [...snapshots, ...rosterCharacters],
      buildRosterCharactersFn,
      upsertRosterSnapshotsFn,
    });

    const snap = statMap.get(normalizeNameKey(entry.name)) || null;
    const className = getBroadcastClassName(snap);
    const classPrefix = className ? `${getClassEmoji(className) || className} ` : '';

    // Description leads with a one-line headline so the recipient
    // sees "What changed in which list" without parsing the fields.
    // Class icon (when known) sits between the list-status icon and
    // the linked name to match the rest of the v0.5.67 vocabulary.
    // Enrich gets a bespoke headline naming the new-alt count + running
    // total (deliberately does NOT name the officer who ran it - the
    // guild only needs to know the entry grew, not by whom).
    const newAlts = (Array.isArray(newAltNames) ? newAltNames : []).filter(Boolean);
    const newCount = newAlts.length;
    const totalTracked = Math.max(0, allChars.filter((n) => normalizeNameKey(n) !== normalizeNameKey(entry.name)).length);
    function buildPayloadForLanguage(lang) {
      const listLabel = t(`dialogue.broadcast.list.${payload.type}`, lang);
      const scopeTag = entry.scope === 'server'
        ? ` \`[${t('dialogue.broadcast.localTag', lang)}]\``
        : '';
      const linkedName = `${classPrefix}**[${entry.name}](${rosterLink})**`;
      const headlineKey = `dialogue.broadcast.headlines.${isEnrich ? 'enriched' : action}`;
      const headline = t(headlineKey, lang, {
        icon,
        name: linkedName,
        list: listLabel,
        scope: scopeTag,
        newCount,
        total: totalTracked,
        altWord: t(`dialogue.broadcast.${newCount === 1 ? 'altOne' : 'altMany'}`, lang),
      });

      const fields = [{
        name: `📝 ${t('dialogue.broadcast.fields.reason', lang)}`,
        value: (entry.reason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024),
        inline: false,
      }];
      if (entry.raid) fields.push({ name: `🗡️ ${t('dialogue.broadcast.fields.raid', lang)}`, value: `\`${entry.raid}\``, inline: true });
      if (entry.addedAt) {
        fields.push({
          name: `🕐 ${t(`dialogue.broadcast.fields.${action === 'edited' ? 'edited' : 'added'}`, lang)}`,
          value: relativeTime(entry.addedAt),
          inline: true,
        });
      }
      if (snap?.itemLevel > 0) {
        fields.push({ name: `📊 ${t('dialogue.broadcast.fields.itemLevel', lang)}`, value: `\`${snap.itemLevel.toFixed(2)}\``, inline: true });
      }
      if (snap?.combatScore) {
        fields.push({ name: `⚔️ ${t('dialogue.broadcast.fields.combatPower', lang)}`, value: snap.combatScore, inline: true });
      }

      const rosterFieldOptions = {
        label: `${isEnrich ? '🆕' : '🧬'} ${t(`dialogue.broadcast.fields.${isEnrich ? 'newAlts' : 'trackedAlts'}`, lang)}`,
        overflowTemplate: t('dialogue.broadcast.more', lang),
      };
      const altsField = isEnrich
        ? renderTrackedAltsField({ names: newAlts, primaryName: entry.name, statMap, ...rosterFieldOptions })
        : buildTrackedAltsField(entry, statMap, rosterFieldOptions);
      if (altsField) fields.push(altsField);

      const titleKey = action in ACTION_VERB ? action : 'fallback';
      const embed = createArtistEmbed(lang)
        .setTitle(`🎨 ${t(`dialogue.broadcast.titles.${titleKey}`, lang, { list: listLabel })}`)
        .setDescription(headline)
        .addFields(fields)
        .setColor(color)
        .setTimestamp(new Date());
      const components = buildBroadcastEvidenceComponents(entry, {
        legacyUrl: preResolvedUrl !== undefined ? preResolvedUrl : entry.imageUrl,
        lang,
      });
      return { embeds: [embed], ...(components.length > 0 ? { components } : {}) };
    }

    const channelIds = await resolveBroadcastChannels(payload.guildId || '', { onlyOwner });
    if (channelIds.size === 0) return;

    await sendEmbedToChannels({
      client,
      channelIds,
      buildPayload: async ({ channel }) => {
        const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });
        return buildPayloadForLanguage(lang);
      },
      logLabel: '[list] Broadcast',
    });
  }

  async function resolveBroadcastChannels(originGuildId, { onlyOwner = false } = {}) {
    const channelIds = new Set();
    const isOwnerOrigin = originGuildId === config.ownerGuildId;

    if (onlyOwner) {
      if (!config.ownerGuildId) return channelIds;
      try {
        const ownerConfig = await GuildConfig.findOne({ guildId: config.ownerGuildId }).lean();
        if (ownerConfig?.globalNotifyEnabled === false) return channelIds;
        if (ownerConfig?.listNotifyChannelId) {
          channelIds.add(ownerConfig.listNotifyChannelId);
        } else {
          for (const envId of config.listNotifyChannelIds) {
            try {
              const ch = await client.channels.fetch(envId);
              if (ch?.guild?.id === config.ownerGuildId) {
                channelIds.add(envId);
                break;
              }
            } catch { /* skip */ }
          }
        }
      } catch (err) {
        console.warn('[list] Failed to query owner GuildConfig:', err.message);
      }
      return channelIds;
    }

    const disabledGuildIds = new Set();
    const dbNotifyGuildIds = new Set();
    try {
      const guildConfigs = await GuildConfig.find({}).lean();
      for (const gc of guildConfigs) {
        if (gc.globalNotifyEnabled === false) disabledGuildIds.add(gc.guildId);
        if (gc.listNotifyChannelId) dbNotifyGuildIds.add(gc.guildId);
        if (gc.guildId === originGuildId && !isOwnerOrigin) continue;
        if (gc.globalNotifyEnabled === false) continue;
        if (!gc.listNotifyChannelId) continue;
        channelIds.add(gc.listNotifyChannelId);
      }
    } catch (err) {
      console.warn('[list] Failed to query GuildConfig for broadcast:', err.message);
    }

    if (config.listNotifyChannelIds.length > 0) {
      for (const envId of config.listNotifyChannelIds) {
        if (channelIds.has(envId)) continue;
        try {
          const ch = await client.channels.fetch(envId);
          if (!ch?.isTextBased()) continue;
          const chGuildId = ch.guild?.id || '';
          if (chGuildId === originGuildId && !isOwnerOrigin) continue;
          if (disabledGuildIds.has(chGuildId)) continue;
          if (dbNotifyGuildIds.has(chGuildId)) continue;
          channelIds.add(envId);
        } catch { /* skip */ }
      }
    }

    return channelIds;
  }

  async function broadcastBulkAdd(addedResults, meta) {
    if (!addedResults || addedResults.length === 0) return;

    const globalEntries = addedResults.filter((r) => r.entry?.scope !== 'server');
    const serverEntries = addedResults.filter((r) => r.entry?.scope === 'server');

    // Snapshot enrichment for the bulk preview line: one query for all
    // names in the batch instead of N. When snapshot data is present,
    // each row picks up a class-icon prefix (matches v0.5.67 vocab);
    // names without a snapshot fall back to the bare name + reason.
    const allBulkNames = addedResults.map((r) => r.entry?.name || r.name).filter(Boolean);
    let snapshotMap = new Map();
    if (allBulkNames.length > 0) {
      try {
        const snaps = await RosterSnapshot.find({ name: { $in: allBulkNames } })
          .collation({ locale: 'en', strength: 2 })
          .lean();
        snapshotMap = new Map(snaps.map((s) => [s.name.toLowerCase(), s]));
      } catch (err) {
        console.warn('[list] Snapshot lookup for bulk broadcast failed (non-fatal):', err.message);
      }
    }

    const renderBulkLine = (i, t, r) => {
      const name = r.entry?.name || r.name;
      const snap = snapshotMap.get(String(name).toLowerCase());
      const cls = snap?.classId ? getClassName(snap.classId) : '';
      const classPrefix = cls ? `${getClassEmoji(cls) || cls} ` : '';
      const reasonShort = (r.entry?.reason || '').length > 60
        ? (r.entry?.reason || '').slice(0, 57) + '...'
        : (r.entry?.reason || '');
      return `${i + 1}. ${listTypeIcon(t)} ${classPrefix}**${name}** · ${reasonShort}`;
    };

    const buildBulkEmbed = (entries, isLocal, lang) => {
      const grouped = { black: [], white: [], watch: [] };
      for (const r of entries) {
        const t = r.type || r.entry?.type || 'black';
        if (grouped[t]) grouped[t].push(r);
      }

      const embed = createArtistEmbed(lang)
        .setTitle(`📢 ${t('dialogue.broadcast.bulkTitle', lang, {
          local: isLocal ? t('dialogue.broadcast.localSuffix', lang) : '',
          count: entries.length,
          entryWord: t(`dialogue.broadcast.${entries.length === 1 ? 'entryOne' : 'entryMany'}`, lang),
        })}`)
        .setColor(COLORS.info)
        .setTimestamp(new Date());

      for (const listType of ['black', 'white', 'watch']) {
        if (grouped[listType].length === 0) continue;
        const lines = grouped[listType]
          .slice(0, 15)
          .map((r, i) => renderBulkLine(i, listType, r))
          .join('\n');
        const suffix = grouped[listType].length > 15
          ? `\n*${t('dialogue.broadcast.more', lang, { count: grouped[listType].length - 15 })}*`
          : '';
        embed.addFields({
          name: `${t(`dialogue.broadcast.list.${listType}`, lang)} (${grouped[listType].length})`,
          value: (lines + suffix).slice(0, 1024),
        });
      }

      return embed;
    };

    const originGuildId = meta.guildId || '';

    if (globalEntries.length > 0) {
      const channelIds = await resolveBroadcastChannels(originGuildId, { onlyOwner: false });
      if (channelIds.size > 0) {
        await sendEmbedToChannels({
          client,
          channelIds,
          buildPayload: async ({ channel }) => {
            const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });
            return { embeds: [buildBulkEmbed(globalEntries, false, lang)] };
          },
          logLabel: '[multiadd] Bulk broadcast',
        });
      }
    }

    if (serverEntries.length > 0) {
      const channelIds = await resolveBroadcastChannels(originGuildId, { onlyOwner: true });
      if (channelIds.size > 0) {
        await sendEmbedToChannels({
          client,
          channelIds,
          buildPayload: async ({ channel }) => {
            const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });
            return { embeds: [buildBulkEmbed(serverEntries, true, lang)] };
          },
          logLabel: '[multiadd] Bulk local broadcast',
        });
      }
    }
  }

  return {
    broadcastListChange,
    resolveBroadcastChannels,
    broadcastBulkAdd,
  };
}
