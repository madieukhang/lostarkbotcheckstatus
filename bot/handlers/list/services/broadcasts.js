/**
 * handlers/list/services/broadcasts.js
 * Cross-guild broadcast helpers · posts list-change notifications to
 * the per-guild notify channel (configured via /la-setup config action:set-notify-channel
 * or LIST_NOTIFY_CHANNEL_IDS env fallback). Also exports the tracked-
 * alts field builder and roster stat-record merge helpers reused by
 * the multiadd reject/summary embeds.
 */

import { ActionRowBuilder } from 'discord.js';
import config from '../../../config.js';
import GuildConfig from '../../../models/GuildConfig.js';
import RosterSnapshot from '../../../models/RosterSnapshot.js';
import { getClassEmoji, getClassName } from '../../../models/Class.js';
import { buildRosterCharacters } from '../../../services/roster/buildRosterCharacters.js';
import { upsertRosterSnapshots } from '../../../services/roster/rosterSnapshots.js';
import { getGuildLanguage, t } from '../../../services/i18n/index.js';
import { COLORS, padInlineRow, relativeTime } from '../../../utils/ui.js';
import { createArtistEmbed } from '../../../utils/artistVoice.js';
import { normalizeNameKey } from '../../../utils/names.js';
import { truncateInlineText } from '../../../utils/discordText.js';
import {
  describeListEntryEdit,
  formatListEditSummary,
  getListContext,
  listTypeIcon,
} from '../helpers.js';
import { buildListEntryReasonField, buildMarkedInlineField } from '../entryCardFields.js';
import { buildBroadcastEvidenceButton } from '../evidence/broadcastButton.js';
import { buildNoteCountLine, buildNoteHistoryButton } from '../notes/entryNotes.js';
import {
  formatAltLine,
  formatLinkedCharacter,
  formatRosterStatBadges,
  renderTrackedAltsField,
  resolveRosterWorld,
} from '../trackedAltsRender.js';

// An add keeps the list icon in the title; the other actions show what
// happened to the entry.
const BROADCAST_TITLE_ICONS = Object.freeze({ removed: '🗑️', edited: '✏️', enriched: '🆕' });

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
    // Carried through because this reshaping is the only thing standing
    // between the roster read and the card · a field dropped here is
    // invisible to every caller no matter what fed the record in.
    world: String(record?.world || '').trim(),
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

// formatBroadcastCharacterLine + buildTrackedAltsField are kept as thin
// wrappers around the shared renderer in handlers/list/trackedAltsRender.js
// so the broadcast-specific public API (which tests import) stays stable
// while the actual rendering logic lives in one place, and cross-server
// broadcasts read identically to the /la-list view evidence detail card.

export const formatBroadcastCharacterLine = formatAltLine;

export function buildTrackedAltsField(entry, statMap = new Map(), options = {}) {
  return renderTrackedAltsField({
    names: entry?.allCharacters,
    primaryName: entry?.name,
    statMap,
    includePrimary: true,
    label: '🧬 Tracked rosters',
    ...options,
  });
}

/**
 * Build the field grid for a list-change broadcast: full-width reason,
 * then the inline metadata row, then the roster list. An edit marks the
 * reason and raid it replaced in place, as the /la-list edit card does.
 * Fixed tokens and numbers (raid, ilvl, CP) are code-wrapped; the
 * timestamp stays plain so Discord can localize <t:UNIX:R>.
 * @param {object} options
 * @param {object} options.entry - the list entry being announced
 * @param {'added'|'edited'|'removed'|'enriched'} options.action - an edit
 *   stamps the time of the edit, every other action the time of the add
 * @param {object} [options.snap] - the entry's own RosterSnapshot
 * @param {object} [options.altsField] - prebuilt roster-list field
 * @param {string} [options.lang='en'] - locale for every label
 * @param {Map<string, object>} [options.statMap] - snapshots for the whole
 *   roster · lets the server fall back to a sibling. Omit to read the
 *   server off `snap` alone.
 * @param {object} [options.previous] - inline values an edit replaced, as
 *   describeListEntryEdit returns them
 * @param {string} [options.previousReason] - the reason an edit replaced
 * @returns {Array<object>} embed fields, inline ones padded to whole rows
 */
export function buildBroadcastFields({
  entry,
  action,
  snap,
  altsField,
  lang = 'en',
  statMap,
  previous = {},
  previousReason,
}) {
  // Server is a roster-level fact, so a sibling's snapshot answers for
  // this entry when its own row has none · see resolveRosterWorld. Falls
  // back to `snap` alone for callers that pass no statMap.
  const world = statMap
    ? resolveRosterWorld(entry, statMap)
    : String(snap?.world || '').trim();
  const notAvailable = t('dialogue.broadcast.notAvailable', lang);
  const raidChanged = 'raid' in previous;
  const stampedAt = action === 'edited' ? new Date() : entry.addedAt;
  const statBadges = formatRosterStatBadges(snap);
  const inlineFields = [
    entry.raid || raidChanged
      ? buildMarkedInlineField(
          `🗡️ ${t('dialogue.broadcast.fields.raid', lang)}`,
          entry.raid ? `\`${entry.raid}\`` : notAvailable,
          raidChanged,
          previous.raid || notAvailable,
        )
      : null,
    stampedAt
      ? {
          name: `🕐 ${t(`dialogue.broadcast.fields.${action === 'edited' ? 'edited' : 'added'}`, lang)}`,
          value: relativeTime(stampedAt),
          inline: true,
        }
      : null,
    statBadges.itemLevel
      ? { name: `📊 ${t('dialogue.broadcast.fields.itemLevel', lang)}`, value: statBadges.itemLevel, inline: true }
      : null,
    statBadges.combatPower
      ? { name: `⚔️ ${t('dialogue.broadcast.fields.combatPower', lang)}`, value: statBadges.combatPower, inline: true }
      : null,
    world
      ? { name: `🌍 ${t('dialogue.roster.server', lang)}`, value: `\`${world}\``, inline: true }
      : null,
  ].filter(Boolean);

  return [
    buildListEntryReasonField({
      reason: entry.reason,
      previousReason,
      // A removed entry has no history left to open.
      noteLine: action === 'removed' ? null : buildNoteCountLine(entry, lang),
      lang,
    }),
    ...padInlineRow(inlineFields),
    altsField,
  ].filter(Boolean);
}

function evidenceRef(entry) {
  return entry.imageMessageId || entry.imageUrl || '';
}

/**
 * What an edit changed, compared against the entry before it: the values
 * to mark in place, the alts it added, and the headline summary for the
 * rest.
 */
function describeBroadcastEdit({ entry, previousEntry, type, previousType, lang }) {
  const { changed, previous, previousReason } = describeListEntryEdit({
    entry, previousEntry, type, previousType, lang,
  });
  const previousAltKeys = new Set((previousEntry.allCharacters || []).map(normalizeNameKey));
  const addedAlts = (entry.allCharacters || [])
    .filter((name) => !previousAltKeys.has(normalizeNameKey(name)));
  const evidenceChanged = evidenceRef(entry) !== evidenceRef(previousEntry);
  const summary = formatListEditSummary({
    changed,
    logsChanged: (entry.logsUrl || '') !== (previousEntry.logsUrl || ''),
    evidenceChanged,
    addedAltCount: addedAlts.length,
    lang,
  });
  return { previous, previousReason, addedAlts, evidenceChanged, summary };
}

/**
 * Build the broadcast message for one list change in one language. The
 * title follows the /la-list success cards, `{list} · {action} · {name}`,
 * and the headline says what happened without naming who did it.
 * @param {object} options
 * @param {'added'|'edited'|'removed'|'enriched'} options.action
 * @param {object} options.entry - the entry as saved
 * @param {string} options.type - list type: black | white | watch
 * @param {Map<string, object>} options.statMap - roster snapshots by name key
 * @param {object} [options.previousEntry] - an edit's entry before the edit;
 *   required when action is 'edited'
 * @param {string} [options.previousType] - an edit's list type before the edit
 * @param {string[]} [options.newAltNames=[]] - alts an enrich run found
 * @param {string} [options.legacyUrl] - image URL for the View evidence
 *   button when the entry has no archived evidence message
 * @param {string} options.lang - locale
 * @returns {{embeds: Array<import('discord.js').EmbedBuilder>, components?: Array<object>}}
 */
export function buildBroadcastPayload({
  action,
  entry,
  type,
  statMap,
  previousEntry,
  previousType = type,
  newAltNames = [],
  legacyUrl,
  lang,
}) {
  const { color, icon } = getListContext(type);
  const listLabel = t(`dialogue.broadcast.list.${type}`, lang);
  const snap = statMap.get(normalizeNameKey(entry.name)) || null;
  const edit = action === 'edited'
    ? describeBroadcastEdit({ entry, previousEntry, type, previousType, lang })
    : null;
  const isEnrich = action === 'enriched';
  const newAlts = newAltNames.filter(Boolean);
  const entryKey = normalizeNameKey(entry.name);
  const totalTracked = (entry.allCharacters || [])
    .filter((name) => normalizeNameKey(name) !== entryKey).length;

  const headline = t(`dialogue.broadcast.headlines.${action}`, lang, {
    name: formatLinkedCharacter(entry.name, snap),
    list: listLabel,
    scope: entry.scope === 'server' ? ` \`[${t('dialogue.broadcast.localTag', lang)}]\`` : '',
    summary: edit?.summary || '',
    newCount: newAlts.length,
    total: totalTracked,
    altWord: t(`dialogue.broadcast.${newAlts.length === 1 ? 'altOne' : 'altMany'}`, lang),
  });

  const rosterFieldOptions = {
    label: `${isEnrich ? '🆕' : '🧬'} ${t(`dialogue.broadcast.fields.${isEnrich ? 'newAlts' : 'trackedRosters'}`, lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  };
  const altsField = isEnrich
    ? renderTrackedAltsField({ names: newAlts, primaryName: entry.name, statMap, ...rosterFieldOptions })
    : buildTrackedAltsField(entry, statMap, { ...rosterFieldOptions, newNames: edit?.addedAlts || [] });
  const fields = buildBroadcastFields({
    entry, action, snap, altsField, lang, statMap,
    previous: edit?.previous,
    previousReason: edit?.previousReason,
  });

  const embed = createArtistEmbed()
    .setTitle(`${BROADCAST_TITLE_ICONS[action] || icon} ${t(`dialogue.broadcast.titles.${action}`, lang, {
      list: listLabel,
      name: entry.name,
    })}`)
    .setDescription(headline)
    .addFields(fields)
    .setColor(color)
    .setTimestamp(new Date());
  const evidenceButton = buildBroadcastEvidenceButton(entry, { legacyUrl, lang });
  const buttons = [
    evidenceButton,
    action === 'removed' ? null : buildNoteHistoryButton(type, entry, lang),
  ].filter(Boolean);
  const components = buttons.length > 0 ? [new ActionRowBuilder().addComponents(buttons)] : [];
  // The broadcast shows no image, so a replaced one is pointed at the button.
  if (edit?.evidenceChanged && evidenceButton) {
    embed.setFooter({ text: t('dialogue.broadcast.evidenceUpdatedFooter', lang) });
  }
  return { embeds: [embed], ...(components.length > 0 ? { components } : {}) };
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
 *   broadcastBulkAdd: Function,
 * }}
 */
export function createBroadcastServices({ client }) {
  async function findOwnerEnvNotifyChannel(channelIds) {
    for (const envId of config.listNotifyChannelIds) {
      try {
        const channel = await client.channels.fetch(envId);
        if (channel?.guild?.id !== config.ownerGuildId) continue;
        channelIds.add(envId);
        return;
      } catch { /* skip */ }
    }
  }

  async function resolveOwnerBroadcastChannels() {
    const channelIds = new Set();
    if (!config.ownerGuildId) return channelIds;
    try {
      const ownerConfig = await GuildConfig.findOne({ guildId: config.ownerGuildId }).lean();
      if (ownerConfig?.globalNotifyEnabled === false) return channelIds;
      if (ownerConfig?.listNotifyChannelId) channelIds.add(ownerConfig.listNotifyChannelId);
      else await findOwnerEnvNotifyChannel(channelIds);
    } catch (err) {
      console.warn('[list] Failed to query owner GuildConfig:', err.message);
    }
    return channelIds;
  }

  function indexConfiguredBroadcastChannels(guildConfigs, originGuildId, isOwnerOrigin) {
    const channelIds = new Set();
    const disabledGuildIds = new Set();
    const dbNotifyGuildIds = new Set();
    for (const guildConfig of guildConfigs) {
      if (guildConfig.globalNotifyEnabled === false) disabledGuildIds.add(guildConfig.guildId);
      if (guildConfig.listNotifyChannelId) dbNotifyGuildIds.add(guildConfig.guildId);
      const excludedOrigin = guildConfig.guildId === originGuildId && !isOwnerOrigin;
      if (excludedOrigin || guildConfig.globalNotifyEnabled === false || !guildConfig.listNotifyChannelId) {
        continue;
      }
      channelIds.add(guildConfig.listNotifyChannelId);
    }
    return { channelIds, disabledGuildIds, dbNotifyGuildIds };
  }

  async function loadConfiguredBroadcastChannels(originGuildId, isOwnerOrigin) {
    try {
      const guildConfigs = await GuildConfig.find({}).lean();
      return indexConfiguredBroadcastChannels(guildConfigs, originGuildId, isOwnerOrigin);
    } catch (err) {
      console.warn('[list] Failed to query GuildConfig for broadcast:', err.message);
      return { channelIds: new Set(), disabledGuildIds: new Set(), dbNotifyGuildIds: new Set() };
    }
  }

  async function appendEnvBroadcastChannels(state, originGuildId, isOwnerOrigin) {
    for (const envId of config.listNotifyChannelIds) {
      if (state.channelIds.has(envId)) continue;
      try {
        const channel = await client.channels.fetch(envId);
        if (!channel?.isTextBased()) continue;
        const guildId = channel.guild?.id || '';
        if (guildId === originGuildId && !isOwnerOrigin) continue;
        if (state.disabledGuildIds.has(guildId) || state.dbNotifyGuildIds.has(guildId)) continue;
        state.channelIds.add(envId);
      } catch { /* skip */ }
    }
  }

  /**
   * Post a list change to every notify channel, each in its server's
   * language.
   * @param {'added'|'edited'|'removed'|'enriched'} action
   * @param {object} entry - the entry as saved
   * @param {object} payload - request context: type, guildId
   * @param {object} [options]
   * @param {boolean} [options.onlyOwner=false] - post to the owner server only
   * @param {string} [options.displayUrl] - pre-resolved evidence image URL
   * @param {object[]} [options.rosterCharacters=[]] - roster stats in hand
   * @param {string[]} [options.newAltNames=[]] - alts an enrich run found
   * @param {object} [options.previousEntry] - an edit's entry before the
   *   edit; required when action is 'edited'
   * @param {string} [options.previousType] - an edit's list type before
   *   the edit, when it moved the entry
   * @returns {Promise<void>}
   */
  async function broadcastListChange(action, entry, payload, options = {}) {
    const {
      onlyOwner = false,
      displayUrl: preResolvedUrl,
      rosterCharacters = [],
      newAltNames = [],
      previousEntry,
      previousType,
    } = options;

    // RosterSnapshot enrichment for class icon + ilvl + CP. Best-effort:
    // if /la-roster has queried this name before, the broadcast carries
    // the class icon, ilvl and CP that the check and scan cards show.
    // Otherwise the headline carries the name only.
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
    });

    const channelIds = await resolveBroadcastChannels(payload.guildId || '', { onlyOwner });
    if (channelIds.size === 0) return;

    await sendEmbedToChannels({
      client,
      channelIds,
      buildPayload: async ({ channel }) => {
        const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });
        return buildBroadcastPayload({
          action,
          entry,
          type: payload.type,
          statMap,
          previousEntry,
          previousType,
          newAltNames,
          legacyUrl: preResolvedUrl !== undefined ? preResolvedUrl : entry.imageUrl,
          lang,
        });
      },
      logLabel: '[list] Broadcast',
    });
  }

  async function resolveBroadcastChannels(originGuildId, { onlyOwner = false } = {}) {
    if (onlyOwner) return resolveOwnerBroadcastChannels();
    const isOwnerOrigin = originGuildId === config.ownerGuildId;
    const state = await loadConfiguredBroadcastChannels(originGuildId, isOwnerOrigin);
    await appendEnvBroadcastChannels(state, originGuildId, isOwnerOrigin);
    return state.channelIds;
  }

  async function broadcastBulkAdd(addedResults, meta) {
    if (!addedResults || addedResults.length === 0) return;

    const globalEntries = addedResults.filter((r) => r.entry?.scope !== 'server');
    const serverEntries = addedResults.filter((r) => r.entry?.scope === 'server');

    // Snapshot enrichment for the bulk preview line: one query for all
    // names in the batch instead of N. When snapshot data is present,
    // each row picks up a class-icon prefix;
    // names without a snapshot fall back to the bare name + reason.
    const allBulkNames = addedResults.map((r) => r.entry?.name || r.name).filter(Boolean);
    let snapshotMap = new Map();
    if (allBulkNames.length > 0) {
      try {
        const snaps = await RosterSnapshot.find({ name: { $in: allBulkNames } })
          .collation({ locale: 'en', strength: 2 })
          .lean();
        snapshotMap = new Map(snaps.map((snapshot) => [normalizeNameKey(snapshot.name), snapshot]));
      } catch (err) {
        console.warn('[list] Snapshot lookup for bulk broadcast failed (non-fatal):', err.message);
      }
    }

    const renderBulkLine = (i, t, r) => {
      const name = r.entry?.name || r.name;
      const snap = snapshotMap.get(normalizeNameKey(name));
      const cls = snap?.classId ? getClassName(snap.classId) : '';
      const classPrefix = cls ? `${getClassEmoji(cls) || cls} ` : '';
      const reasonShort = truncateInlineText(r.entry?.reason, 60);
      return `${i + 1}. ${listTypeIcon(t)} ${classPrefix}**${name}** · ${reasonShort}`;
    };

    const buildBulkEmbed = (entries, isLocal, lang) => {
      const grouped = { black: [], white: [], watch: [] };
      for (const r of entries) {
        const t = r.type || r.entry?.type || 'black';
        if (grouped[t]) grouped[t].push(r);
      }

      const embed = createArtistEmbed()
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

    const deliveryRoutes = [
      {
        entries: globalEntries,
        onlyOwner: false,
        isLocal: false,
        logLabel: '[multiadd] Bulk broadcast',
      },
      {
        entries: serverEntries,
        onlyOwner: true,
        isLocal: true,
        logLabel: '[multiadd] Bulk local broadcast',
      },
    ];

    for (const { entries, onlyOwner, isLocal, logLabel } of deliveryRoutes) {
      if (entries.length === 0) continue;
      const channelIds = await resolveBroadcastChannels(originGuildId, { onlyOwner });
      if (channelIds.size === 0) continue;

      await sendEmbedToChannels({
        client,
        channelIds,
        buildPayload: async ({ channel }) => {
          const lang = await getGuildLanguage(channel.guild?.id, { GuildConfigModel: GuildConfig });
          return { embeds: [buildBulkEmbed(entries, isLocal, lang)] };
        },
        logLabel,
      });
    }
  }

  return {
    broadcastListChange,
    broadcastBulkAdd,
  };
}
