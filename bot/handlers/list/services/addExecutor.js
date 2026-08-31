/**
 * handlers/list/services/addExecutor.js
 * The actual add-to-DB executor + the hidden-roster guidance embed
 * builder. Both /la-list add (auto-approve + approval-approved paths)
 * and the approval-button handler call into executeListAddToDatabase
 * here · this is the single place that persists, stamps enrichment
 * metadata, runs dupe checks, and renders the success card.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { connectDB } from '../../../db.js';
import TrustedUser from '../../../models/TrustedUser.js';
import { getClassEmoji, getClassName } from '../../../models/Class.js';
import {
  buildRosterCharacters,
  fetchCharacterMeta,
  fetchNameSuggestions,
  upsertRosterSnapshots,
} from '../../../services/roster/index.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { BLANK_FIELD_VALUE, ICONS, padInlineRow, relativeTime } from '../../../utils/ui.js';
import { t } from '../../../services/i18n/index.js';
import { resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { rosterUrl, logsUrl } from '../../../utils/rosterLink.js';
import {
  formatLinkedCharacter,
  renderTrackedAltsField,
  resolveRosterWorld,
  statMapFromRosterCharacters,
} from '../trackedAltsRender.js';
import {
  getListContext,
  buildTrustedBlockEmbed,
} from '../helpers.js';

export function buildHiddenRosterGuidance(entryName, guildName, lang = 'en') {
  const hasGuild = Boolean(String(guildName || '').trim());
  const fields = [{
    name: `${ICONS.search} ${t('dialogue.listAdd.hidden.title', lang)}`,
    value: t(`dialogue.listAdd.hidden.${hasGuild ? 'withGuild' : 'withoutGuild'}`, lang, { guild: guildName, name: entryName }),
    inline: false,
  }];

  const components = [];
  if (hasGuild) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`list-add:enrich-hidden:${encodeURIComponent(entryName)}`)
          .setLabel(t('common.actions.enrichNow', lang))
          .setEmoji(ICONS.search)
          .setStyle(ButtonStyle.Primary)
      )
    );
  }

  return { fields, components };
}

function buildInlineSpacer() {
  return { name: '\u200b', value: '\u200b', inline: true };
}

/**
 * Build the three-slot audit row for an "already exists" result. Legacy
 * entries may lack one or both values, so both visible fields retain a
 * localized fallback instead of disappearing and shifting the card layout.
 *
 * @param {object} existed
 * @param {string} [lang='en']
 * @returns {Array<{name: string, value: string, inline: true}>}
 */
export function buildDuplicateAuditFields(existed, lang = 'en') {
  const fallback = t('dialogue.broadcast.notAvailable', lang);
  return [
    {
      name: `👤 ${t('dialogue.listAdd.duplicate.addedBy', lang)}`,
      value: existed.addedByDisplayName || existed.addedByTag || fallback,
      inline: true,
    },
    {
      name: `🕐 ${t('dialogue.listAdd.duplicate.timeAdded', lang)}`,
      value: relativeTime(existed.addedAt) || fallback,
      inline: true,
    },
    // Keep the audit pair on the same three-column grid as Match type / Scope.
    // Without this final slot Discord stretches two fields to 50/50 and makes
    // Time added look shifted to the right.
    buildInlineSpacer(),
  ];
}

/**
 * Pad preceding inline metadata to a complete row, then append the stable
 * Added by / Time added / spacer row.
 */
export function appendDuplicateAuditRow(fields, existed, lang = 'en') {
  while (fields.length % 3 !== 0) fields.push(buildInlineSpacer());
  fields.push(...buildDuplicateAuditFields(existed, lang));
  return fields;
}

/**
 * Build the title icon + hero line shared by direct and approval-completed
 * adds. The list icon is the only title prefix; the linked primary character
 * carries its class icon in the description.
 */
export function buildListAddSuccessHeader({
  icon,
  requesterName,
  entryName,
  listLabel,
  scopeTag = '',
  primaryRecord = null,
  lang = 'en',
}) {
  return {
    titleIcon: icon,
    heroLine: t('dialogue.listAdd.success.hero', lang, {
      user: requesterName,
      name: formatLinkedCharacter(entryName, primaryRecord),
      list: listLabel,
      scope: scopeTag,
    }),
  };
}

/**
 * Build the complete roster field for an add-success card. The primary
 * character is prepended even when an upstream roster result omitted it, and
 * the shared renderer removes case-insensitive duplicates before counting.
 */
export function buildListAddTrackedRostersField({
  names,
  primaryName,
  statMap = new Map(),
  lang = 'en',
}) {
  return renderTrackedAltsField({
    names,
    primaryName,
    statMap,
    includePrimary: true,
    label: `🧬 ${t('dialogue.listAdd.success.fields.trackedRosters', lang)}`,
    overflowTemplate: t('dialogue.broadcast.more', lang),
  });
}

function buildTrustedRejection(name, trustedEntry, lang, { viaRoster = false } = {}) {
  const trustedName = trustedEntry.name;
  const via = trustedName.toLowerCase() === name.toLowerCase()
    ? {}
    : { via: trustedName };
  return {
    ok: false,
    content: viaRoster
      ? t('dialogue.trustedBlock.via', lang, { name, via: trustedName })
      : t('dialogue.trustedBlock.direct', lang, { name }),
    embeds: [buildTrustedBlockEmbed(name, trustedEntry.reason, { ...via, lang })],
  };
}

async function findTrustedEntry(names) {
  return TrustedUser.findOne(buildNameRosterQuery(names))
    .collation({ locale: 'en', strength: 2 })
    .lean();
}

function formatNameSuggestionLines(suggestions) {
  return suggestions.slice(0, 10).map((suggestion, index) => {
    const className = getClassName(suggestion.cls);
    const classLabel = getClassEmoji(className) || className;
    const itemLevel = Number(suggestion.itemLevel || 0).toFixed(2);
    return `**${index + 1}.** [${suggestion.name}](${rosterUrl(suggestion.name)}) · \`${itemLevel}\` · ${classLabel}`;
  }).join('\n');
}

function buildMissingRosterResult(name, suggestions, lang) {
  const hasSuggestions = suggestions.length > 0;
  const fields = hasSuggestions
    ? [{
        name: `${ICONS.search} ${t('dialogue.listAdd.noRoster.suggestions', lang)}`,
        value: formatNameSuggestionLines(suggestions).slice(0, 1024),
        inline: false,
      }]
    : undefined;
  return {
    ok: false,
    content: hasSuggestions
      ? t('dialogue.listAdd.noRoster.contentSuggestions', lang, { name, count: suggestions.length })
      : t('dialogue.listAdd.noRoster.contentNone', lang, { name }),
    embeds: [buildAlertEmbed({
      severity: AlertSeverity.ERROR,
      title: t('dialogue.listAdd.noRoster.title', lang),
      description: t(
        `dialogue.listAdd.noRoster.${hasSuggestions ? 'withSuggestions' : 'withoutSuggestions'}`,
        lang,
        { name }
      ),
      fields,
      footer: t(
        `dialogue.listAdd.noRoster.${hasSuggestions ? 'suggestionFooter' : 'spellingFooter'}`,
        lang
      ),
      lang,
    })],
  };
}

async function saveRosterSnapshotsBestEffort(rosterCharacters, name) {
  try {
    await upsertRosterSnapshots(rosterCharacters, name);
  } catch (err) {
    console.warn('[list] Snapshot save after roster fetch failed (non-fatal):', err.message);
  }
}

function buildItemLevelRejection({ name, targetItemLevel, labelCap, lang }) {
  if (targetItemLevel === null || targetItemLevel >= 1700) return null;
  const formattedLevel = targetItemLevel.toFixed(2);
  return {
    ok: false,
    content: t('dialogue.listAdd.itemLevel.content', lang, { name, level: formattedLevel }),
    embeds: [buildAlertEmbed({
      severity: AlertSeverity.ERROR,
      title: t('dialogue.listAdd.itemLevel.title', lang),
      description: t('dialogue.listAdd.itemLevel.description', lang, { name }),
      fields: [
        { name: `🎯 ${t('dialogue.listAdd.itemLevel.character', lang)}`, value: `[${name}](${rosterUrl(name)})`, inline: true },
        { name: `📊 ${t('dialogue.listAdd.itemLevel.itemLevel', lang)}`, value: `\`${formattedLevel}\``, inline: true },
        { name: `📉 ${t('dialogue.listAdd.itemLevel.minimum', lang)}`, value: '`1700.00`', inline: true },
        { name: `📒 ${t('dialogue.listAdd.itemLevel.targetList', lang)}`, value: labelCap, inline: true },
        buildInlineSpacer(),
        buildInlineSpacer(),
      ],
      footer: t('dialogue.listAdd.itemLevel.footer', lang),
      lang,
    })],
  };
}

function buildDuplicateMetadataFields(existed, isRosterMatch, lang) {
  const fields = [{
    name: `${ICONS.search} ${t('dialogue.listAdd.duplicate.matchType', lang)}`,
    value: t(
      `dialogue.listAdd.duplicate.${isRosterMatch ? 'rosterAlt' : 'exactName'}`,
      lang
    ),
    inline: true,
  }];
  if (isRosterMatch) {
    fields.push({
      name: `🧬 ${t('dialogue.listAdd.duplicate.matchedName', lang)}`,
      value: `[${existed.name}](${rosterUrl(existed.name)})`,
      inline: true,
    });
  }
  if (existed.scope) {
    const scopeKey = existed.scope === 'server' ? 'local' : 'global';
    fields.push({
      name: `🌐 ${t('dialogue.listAdd.duplicate.scope', lang)}`,
      value: `[${t(`dialogue.approval.scopeTag.${scopeKey}`, lang)}]`,
      inline: true,
    });
  }
  appendDuplicateAuditRow(fields, existed, lang);
  return fields;
}

function appendDuplicateDetailFields(fields, existed, lang) {
  if (existed.reason) {
    fields.push({
      name: `📝 ${t('dialogue.listAdd.duplicate.existingReason', lang)}`,
      value: existed.reason.slice(0, 1024),
      inline: false,
    });
  }
  if (existed.raid) {
    fields.push({
      name: `🗡️ ${t('dialogue.listAdd.duplicate.raid', lang)}`,
      value: `\`${existed.raid}\``,
      inline: true,
    });
  }
  return fields;
}

export function buildDuplicateListAddResult({ existed, name, labelCap, type, lang }) {
  const isRosterMatch = existed.name.toLowerCase() !== name.toLowerCase();
  const variant = isRosterMatch ? 'roster' : 'direct';
  const contentVariant = isRosterMatch ? 'contentRoster' : 'contentDirect';
  const values = { name, list: labelCap, matched: existed.name };
  const fields = appendDuplicateDetailFields(
    buildDuplicateMetadataFields(existed, isRosterMatch, lang),
    existed,
    lang
  );
  return {
    ok: false,
    isDuplicate: true,
    existingEntry: existed,
    content: t(`dialogue.listAdd.duplicate.${contentVariant}`, lang, values),
    embeds: [buildAlertEmbed({
      severity: AlertSeverity.WARNING,
      title: t('dialogue.listAdd.duplicate.title', lang, { list: labelCap }),
      description: t(`dialogue.listAdd.duplicate.${variant}`, lang, values),
      fields,
      footer: t('dialogue.listAdd.duplicate.footer', lang, { type }),
      timestamp: false,
      lang,
    })],
  };
}

function resolveEntryScope(payload) {
  const scope = payload.scope || 'global';
  return { scope, guildId: scope === 'server' ? (payload.guildId || '') : '' };
}

export function buildListEntryCreateData({ payload, name, allCharacters, entryScope }) {
  const data = {
    name,
    reason: payload.reason,
    raid: payload.raid,
    logsUrl: payload.logsUrl || '',
    imageUrl: payload.imageMessageId ? '' : (payload.imageUrl || ''),
    imageMessageId: payload.imageMessageId || '',
    imageChannelId: payload.imageChannelId || '',
    allCharacters,
    enrichmentSource: 'bible',
    enrichedAt: new Date(),
    addedByUserId: payload.requestedByUserId,
    addedByTag: payload.requestedByTag,
    addedByName: payload.requestedByName,
    addedByDisplayName: payload.requestedByDisplayName,
  };
  if (payload.type === 'black') {
    data.scope = entryScope.scope;
    data.guildId = entryScope.guildId;
  }
  return data;
}

function resolveSuccessScopeTag(payload, entryScope, lang) {
  if (payload.type !== 'black') return '';
  const scopeKey = entryScope.scope === 'server' ? 'local' : 'global';
  return ` \`[${t(`dialogue.approval.scopeTag.${scopeKey}`, lang)}]\``;
}

function buildSuccessLinkParts(entryName, payload, lang) {
  const links = [
    `[${t('dialogue.listAdd.success.roster', lang)}](${rosterUrl(entryName)})`,
    `[${t('dialogue.listAdd.success.logs', lang)}](${logsUrl(entryName)})`,
  ];
  if (payload.logsUrl) {
    links.push(`[${t('dialogue.listAdd.success.evidenceLogs', lang)}](${payload.logsUrl})`);
  }
  return links;
}

/**
 * Build the field grid for the `/la-list add` success card: the inline
 * run (list, raid, scope, server) padded to whole rows, then the
 * full-width reason, roster list and links.
 * @param {object} options
 * @param {object} options.payload - the add request (raid, reason, type)
 * @param {object} options.entry - the saved list entry
 * @param {{scope: string}} options.entryScope - resolved scope of the entry
 * @param {string} options.icon - list-status icon shown beside the label
 * @param {string} options.labelCap - capitalized list name
 * @param {object} [options.rostersField] - prebuilt roster-list field
 * @param {string[]} options.linkParts - rendered links, joined with a dot
 * @param {string} options.lang - locale for every label
 * @param {Map<string, object>} [options.statMap] - roster snapshots, used
 *   to resolve the server across the roster
 * @returns {Array<object>} embed fields, inline ones padded to whole rows
 */
export function buildListAddSuccessFields({
  payload,
  entry,
  entryScope,
  icon,
  labelCap,
  rostersField,
  linkParts,
  lang,
  statMap,
}) {
  const inlineFields = [
    { name: `📒 ${t('dialogue.listAdd.success.fields.list', lang)}`, value: `${icon} ${labelCap}`, inline: true },
    { name: `🗡️ ${t('dialogue.listAdd.success.fields.raid', lang)}`, value: payload.raid ? `\`${payload.raid}\`` : t('dialogue.broadcast.notAvailable', lang), inline: true },
  ];
  if (payload.type === 'black') {
    const scopeKey = entryScope.scope === 'server' ? 'local' : 'global';
    inlineFields.push({
      name: `🌐 ${t('dialogue.listAdd.success.fields.scope', lang)}`,
      value: t(`dialogue.approval.scopeTag.${scopeKey}`, lang),
      inline: true,
    });
  }
  // The add flow has just read the roster page, so the server is known
  // here without another request · resolveRosterWorld also covers the
  // case where the entry's own record is the one missing it.
  const world = resolveRosterWorld(entry, statMap);
  if (world) {
    inlineFields.push({
      name: `🌍 ${t('dialogue.roster.server', lang)}`,
      value: `\`${world}\``,
      inline: true,
    });
  }

  // Blacklist adds reach four inline fields (list, raid, scope, server),
  // which Discord would render as a row of three plus one banner.
  const fields = [...padInlineRow(inlineFields)];
  fields.push({
    name: `📝 ${t('dialogue.listAdd.success.fields.reason', lang)}`,
    value: (payload.reason || t('dialogue.broadcast.notAvailable', lang)).slice(0, 1024),
    inline: false,
  });
  if (rostersField) fields.push(rostersField);
  fields.push({
    name: `🔗 ${t('dialogue.listAdd.success.fields.links', lang)}`,
    value: linkParts.join(' · '),
    inline: false,
  });
  return fields;
}

function buildListAddSuccessEmbed({
  payload,
  entry,
  entryScope,
  rosterVisibility,
  rosterCharacters,
  color,
  icon,
  labelCap,
  lang,
}) {
  const rosterStatMap = statMapFromRosterCharacters(rosterCharacters);
  const rostersField = buildListAddTrackedRostersField({
    names: entry.allCharacters,
    primaryName: entry.name,
    statMap: rosterStatMap,
    lang,
  });
  const requesterName = payload.requestedByDisplayName
    || payload.requestedByName
    || t('dialogue.listAdd.success.officerFallback', lang);
  const { titleIcon, heroLine } = buildListAddSuccessHeader({
    icon,
    requesterName,
    entryName: entry.name,
    listLabel: labelCap,
    scopeTag: resolveSuccessScopeTag(payload, entryScope, lang),
    primaryRecord: rosterStatMap.get(entry.name.toLowerCase()) || null,
    lang,
  });
  const fields = buildListAddSuccessFields({
    payload,
    entry,
    entryScope,
    icon,
    labelCap,
    rostersField,
    linkParts: buildSuccessLinkParts(entry.name, payload, lang),
    lang,
    statMap: rosterStatMap,
  });
  const sourceKey = rosterVisibility === 'hidden' ? 'sourceHidden' : 'sourceVisible';
  return buildAlertEmbed({
    severity: AlertSeverity.SUCCESS,
    titleIcon,
    color,
    title: t('dialogue.listAdd.success.title', lang, { list: labelCap, name: entry.name }),
    description: heroLine,
    fields,
    footer: `${ICONS.shield} ${t('dialogue.listAdd.success.footer', lang, {
      user: requesterName,
      source: t(`dialogue.listAdd.success.${sourceKey}`, lang),
    })}`,
    lang,
  });
}

function dispatchListAddBroadcast({
  payload,
  entry,
  entryScope,
  freshDisplayUrl,
  rosterCharacters,
  broadcastListChange,
}) {
  if (payload.skipBroadcast) return;
  broadcastListChange('added', entry, payload, {
    onlyOwner: entryScope.scope === 'server',
    displayUrl: freshDisplayUrl,
    rosterCharacters,
  }).catch((err) => console.warn('[list] Broadcast failed:', err.message));
}

function appendHiddenRosterGuidance({
  embed,
  entry,
  rosterVisibility,
  hiddenRosterMeta,
  lang,
}) {
  if (rosterVisibility !== 'hidden') return [];
  const guidance = buildHiddenRosterGuidance(entry.name, hiddenRosterMeta?.guildName, lang);
  embed.addFields(...guidance.fields);
  return guidance.components;
}

async function buildSuccessfulAddResult({
  payload,
  entry,
  entryScope,
  rosterVisibility,
  rosterCharacters,
  hiddenRosterMeta,
  color,
  icon,
  labelCap,
  lang,
  client,
  broadcastListChange,
}) {
  const embed = buildListAddSuccessEmbed({
    payload,
    entry,
    entryScope,
    rosterVisibility,
    rosterCharacters,
    color,
    icon,
    labelCap,
    lang,
  });
  const freshDisplayUrl = await resolveDisplayImageUrl(entry, client);
  if (freshDisplayUrl) {
    // Heading for the embedded image, same as the other cards that show
    // one · it otherwise butts straight against the last field.
    embed.addFields({
      name: t('listView.evidence.attached', lang),
      value: BLANK_FIELD_VALUE,
      inline: false,
    });
    embed.setImage(freshDisplayUrl);
  }
  dispatchListAddBroadcast({
    payload,
    entry,
    entryScope,
    freshDisplayUrl,
    rosterCharacters,
    broadcastListChange,
  });
  const components = appendHiddenRosterGuidance({
    embed,
    entry,
    rosterVisibility,
    hiddenRosterMeta,
    lang,
  });
  return {
    ok: true,
    entry,
    content: `✅ ${t('dialogue.listAdd.success.content', lang, { name: entry.name, list: labelCap })}`,
    embeds: [embed],
    components,
  };
}

/**
 * Build the executeListAddToDatabase executor.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client
 *   (used by the hidden-roster guidance "Enrich now" button + the
 *   success card's evidence-rehost path)
 * @param {Function} deps.broadcastListChange - guild broadcast helper
 *   called after a successful add so the per-guild notify channel
 *   gets the update.
 * @returns {{executeListAddToDatabase: Function}} the executor (shared
 *   call site between auto-approve + approval-button paths).
 */
export function createListAddExecutor({ client, broadcastListChange }) {
  async function executeListAddToDatabase(payload) {
    const lang = payload.lang || 'en';
    const { model, color, icon } = getListContext(payload.type);
    const labelCap = t(`dialogue.broadcast.list.${payload.type}`, lang);
    const name = normalizeCharacterName(payload.name);
    await connectDB();

    const trustedExact = await findTrustedEntry(name);
    if (trustedExact) {
      return buildTrustedRejection(name, trustedExact, lang);
    }

    const roster = await buildRosterCharacters(name, { hiddenRosterFallback: true });
    const hiddenRosterMeta = roster.rosterVisibility === 'hidden'
      ? await fetchCharacterMeta(name)
      : null;
    if (!roster.hasValidRoster) {
      const suggestions = await fetchNameSuggestions(name) || [];
      return buildMissingRosterResult(name, suggestions, lang);
    }

    await saveRosterSnapshotsBestEffort(roster.rosterCharacters, name);
    const itemLevelRejection = buildItemLevelRejection({
      name,
      targetItemLevel: roster.targetItemLevel,
      labelCap,
      lang,
    });
    if (itemLevelRejection) return itemLevelRejection;

    const trustedAlt = roster.allCharacters.length > 0
      ? await findTrustedEntry(roster.allCharacters)
      : null;
    if (trustedAlt) {
      return buildTrustedRejection(name, trustedAlt, lang, { viaRoster: true });
    }

    const entryScope = resolveEntryScope(payload);
    const duplicateQuery = buildScopedListQuery(
      payload.type,
      buildNameRosterQuery(name),
      entryScope.guildId,
      { ownerSeesAll: false }
    );
    const existed = await model.findOne(duplicateQuery)
      .collation({ locale: 'en', strength: 2 })
      .lean();
    if (existed) {
      return buildDuplicateListAddResult({
        existed,
        name,
        labelCap,
        type: payload.type,
        lang,
      });
    }

    const entry = await model.create(buildListEntryCreateData({
      payload,
      name,
      allCharacters: roster.allCharacters,
      entryScope,
    }));
    return buildSuccessfulAddResult({
      payload,
      entry,
      entryScope,
      rosterVisibility: roster.rosterVisibility,
      rosterCharacters: roster.rosterCharacters,
      hiddenRosterMeta,
      color,
      icon,
      labelCap,
      lang,
      client,
      broadcastListChange,
    });
  }

  return executeListAddToDatabase;
}
