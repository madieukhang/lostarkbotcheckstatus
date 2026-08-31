/**
 * handlers/roster/hiddenRoster.js
 * Hidden-roster branch of /la-roster · fired when the bible roster
 * page returns no characters (account is hidden). Renders the single
 * resolved character via fetchCharacterMeta, inlines any blacklist /
 * whitelist hit's evidence card so the operator sees it without
 * re-running /la-evidence, and offers the same deep-scan button as
 * the visible path.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';

import { connectDB } from '../../db.js';
import config from '../../config.js';
import { buildBlacklistQuery } from '../../utils/scope.js';
import { buildNameRosterQuery } from '../../utils/listEntryMap.js';
import { COLORS, ICONS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import Blacklist from '../../models/Blacklist.js';
import Whitelist from '../../models/Whitelist.js';
import UserPreference from '../../models/UserPreference.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import {
  detectAltsViaStronghold,
  fetchCharacterMeta,
  fetchGuildMembers,
  fetchNameSuggestions,
  formatSuggestionLines,
} from '../../services/roster/index.js';
import {
  buildScanResultEmbed,
  buildScanResultButtons,
} from '../../utils/scanResultEmbed.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { createRosterContinuationSession } from '../../utils/rosterDeepSession.js';
import { rosterUrl, profileUrl as bibleProfileUrl } from '../../utils/rosterLink.js';
import { createRosterScanRuntime, formatDeepScanStats } from './progress.js';
import { resolveRosterScanOutcome } from './completion.js';

async function loadGuildListHits(guildMembers, guildId) {
  const memberNames = guildMembers.map((member) => member.name);
  const memberNameQuery = buildNameRosterQuery(memberNames);
  const [black, white] = await Promise.all([
    Blacklist.find(buildBlacklistQuery(memberNameQuery, guildId || ''))
      .collation({ locale: 'en', strength: 2 })
      .lean(),
    Whitelist.find(memberNameQuery)
      .collation({ locale: 'en', strength: 2 })
      .lean(),
  ]);
  return { black, white };
}

function buildHiddenScanError(err, name, lang) {
  return buildAlertEmbed({
    severity: AlertSeverity.ERROR,
    ...t('dialogue.scan.stopped', lang, {
      name,
      reason: err.message || t('dialogue.scan.unexpectedError', lang),
    }),
    footer: t('dialogue.scan.stopped.rosterStillShown', lang),
    lang,
  });
}

async function runHiddenDeepScan({ interaction, replyEditor, name, meta, guildMembers, deepOptions, lang }) {
  const filteredCount = guildMembers.filter((member) => member.name !== name && member.ilvl >= 1700).length;
  const cap = deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit;
  const scan = createRosterScanRuntime({
    interaction,
    replyEditor,
    name,
    meta,
    totalMembers: guildMembers.length,
    label: `${name} (roster deep · hidden)`,
    lang,
  });
  await replyEditor.edit(scan.buildInitialPayload({
    title: t('dialogue.scan.progress', lang, { name }),
    subtitle: `${t('dialogue.scan.guildMembers', lang, {
      guild: meta.guildName,
      count: guildMembers.length,
    })} · ${t('dialogue.scan.hiddenRoster', lang)}`,
    totalCandidates: Math.min(filteredCount, cap || filteredCount),
  })).catch(() => {});

  try {
    const result = await detectAltsViaStronghold(name, {
      ...deepOptions,
      viaWorker: true,
      targetMeta: meta,
      guildMembers,
      cancelFlag: scan.cancelFlag,
      onProgress: scan.onProgress,
    });
    return { result, errorEmbed: null };
  } catch (err) {
    return { result: null, errorEmbed: buildHiddenScanError(err, name, lang) };
  } finally {
    scan.close();
  }
}

function listHitLines(entries, icon, noReason, lang) {
  const headingKey = icon === '⛔' ? 'blackGuild' : 'whiteGuild';
  return [
    '',
    `**${icon} ${t(`dialogue.roster.${headingKey}`, lang, { count: entries.length })}**`,
    ...entries.map((entry) => (
      `${icon} **${entry.name}** · ${entry.reason || noReason}${entry.raid ? ` [${entry.raid}]` : ''}`
    )),
  ];
}

export function buildHiddenDescription({ meta, guildMembers, hits, deep, lang }) {
  const noReason = t('dialogue.roster.noReason', lang);
  const world = String(meta.world || '').trim();
  const parts = [
    t('dialogue.roster.hiddenStatus', lang, { guild: meta.guildName, count: guildMembers.length }),
    ...(world ? [`**${t('dialogue.roster.server', lang)}:** \`${world}\``] : []),
    t('dialogue.roster.stronghold', lang, {
      stronghold: meta.strongholdName,
      strongholdLevel: meta.strongholdLevel,
      rosterLevel: meta.rosterLevel,
    }),
    ...(!deep ? ['', t('dialogue.roster.noDeep', lang)] : []),
    ...(hits.black.length > 0 ? listHitLines(hits.black, '⛔', noReason, lang) : []),
    ...(hits.white.length > 0 ? listHitLines(hits.white, '✅', noReason, lang) : []),
  ];
  return parts.join('\n');
}

function hiddenRosterColor(hits) {
  if (hits.black.length > 0) return COLORS.danger;
  if (hits.white.length > 0) return COLORS.success;
  return COLORS.warning;
}

function buildHiddenPrimaryEmbed({ name, meta, guildMembers, hits, deep, altResult, lang }) {
  const description = buildHiddenDescription({ meta, guildMembers, hits, deep, lang });
  const deepStats = formatDeepScanStats(altResult, lang);
  return createArtistEmbed(lang)
    .setTitle(`🔒 ${t('dialogue.roster.hiddenTitle', lang, { name })}`)
    .setURL(bibleProfileUrl(name))
    .setDescription(description.length > 4000 ? `${description.slice(0, 4000)}\n…` : description)
    .setColor(hiddenRosterColor(hits))
    .setFooter({
      text: t('dialogue.roster.guildFooter', lang, {
        count: guildMembers.length,
        word: t(`dialogue.roster.${guildMembers.length === 1 ? 'memberOne' : 'memberMany'}`, lang),
        stats: deepStats ? ` · ${deepStats}` : '',
      }),
    })
    .setTimestamp();
}

function buildHiddenReply({ interaction, name, meta, guildMembers, deepOptions, altResult, errorEmbed, primaryEmbed, lang }) {
  const embeds = [primaryEmbed];
  const components = [];
  if (errorEmbed) {
    embeds.push(errorEmbed);
    return { embeds, components };
  }
  if (!altResult) return { embeds, components };

  const { embed: scanEmbed, state } = buildScanResultEmbed({
    target: { name, isHidden: true, guildName: meta.guildName, profileUrl: rosterUrl(name) },
    result: altResult,
    kind: 'roster-hidden',
    summaryLine: t('dialogue.enrich.summary', lang, { guild: meta.guildName, name, resumed: '' }),
    lang,
  });
  embeds.push(scanEmbed);
  if (!state.hasRemaining) return { embeds, components };

  const session = createRosterContinuationSession({
    callerId: interaction.user.id,
    targetName: name,
    isHidden: true,
    meta,
    guildMembers,
    altResult,
    cap: deepOptions.candidateLimit ?? config.strongholdDeepCandidateLimit,
    primaryEmbedJSON: primaryEmbed.toJSON(),
  });
  const buttonRow = buildScanResultButtons({
    kind: 'roster',
    sessionId: session.sessionId,
    hasAlts: (altResult.alts || []).length > 0,
    hasRemaining: true,
    lang,
  });
  if (buttonRow) components.push(buttonRow);
  return { embeds, components };
}

function notifyHiddenScanCompletion({ interaction, replyEditor, name, meta, altResult, lang }) {
  const outcome = resolveRosterScanOutcome(altResult);
  if (!outcome) return;
  sendScanCompletionDm({
    user: interaction.user,
    commandLabel: '/la-roster deep',
    scanTargetName: name,
    guildName: meta.guildName,
    channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
    resultMessageUrl: buildResultMessageUrl(interaction, replyEditor.getMessage()),
    outcome,
    result: altResult,
    lang,
  }).catch(() => {});
}

async function replyWithHiddenRosterSuggestions(replyEditor, name, lang) {
  const suggestions = await fetchNameSuggestions(name) || [];
  const filtered = suggestions.filter((suggestion) => suggestion.itemLevel > 1700);
  const alert = filtered.length > 0
    ? {
      severity: AlertSeverity.ERROR,
      title: t('dialogue.listAdd.noRoster.title', lang),
      description: t('dialogue.listAdd.noRoster.withSuggestions', lang, { name }),
      fields: [{
        name: `${ICONS.search} ${t('dialogue.listAdd.noRoster.suggestions', lang)}`,
        value: formatSuggestionLines(filtered).slice(0, 1024),
        inline: false,
      }],
      footer: t('dialogue.listAdd.noRoster.suggestionFooter', lang),
      lang,
    }
    : {
      severity: AlertSeverity.ERROR,
      title: t('dialogue.listAdd.noRoster.title', lang),
      description: t('dialogue.listAdd.noRoster.withoutSuggestions', lang, { name }),
      footer: t('dialogue.listAdd.noRoster.spellingFooter', lang),
      lang,
    };
  await replyEditor.edit({ embeds: [buildAlertEmbed(alert)] });
}

/**
 * Render the hidden-roster card for /la-roster.
 * @param {object} args
 * @param {import('discord.js').Interaction} args.interaction
 * @param {Function} args.replyEditor - shared editor function passed
 *   by command.js so this module doesn't need to know whether the
 *   reply has been deferred or not.
 * @param {string} args.name - the queried character name
 * @param {boolean} args.deep - whether the caller passed deep:true
 * @param {object} args.deepOptions - deep-scan tuning (concurrency,
 *   candidate cap, etc.) forwarded to detectAltsViaStronghold
 * @returns {Promise<void>}
 */
export async function handleHiddenRosterResult({ interaction, replyEditor, name, deep, deepOptions }) {
  await connectDB();
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
  const meta = await fetchCharacterMeta(name, {
    timeoutMs: config.strongholdDeepCandidateTimeoutMs,
    viaWorker: true,
  });
  if (!meta?.guildName) {
    await replyWithHiddenRosterSuggestions(replyEditor, name, lang);
    return;
  }

  const guildMembers = await fetchGuildMembers(name, {
    timeoutMs: config.strongholdDeepCandidateTimeoutMs,
    cacheKey: meta.guildName,
    viaWorker: true,
  });
  const hits = await loadGuildListHits(guildMembers, interaction.guild?.id);
  const scan = deep
    ? await runHiddenDeepScan({
      interaction,
      replyEditor,
      name,
      meta,
      guildMembers,
      deepOptions,
      lang,
    })
    : { result: null, errorEmbed: null };
  const primaryEmbed = buildHiddenPrimaryEmbed({
    name,
    meta,
    guildMembers,
    hits,
    deep,
    altResult: scan.result,
    lang,
  });
  const payload = buildHiddenReply({
    interaction,
    name,
    meta,
    guildMembers,
    deepOptions,
    altResult: scan.result,
    errorEmbed: scan.errorEmbed,
    primaryEmbed,
    lang,
  });
  await replyEditor.edit(payload);
  notifyHiddenScanCompletion({
    interaction,
    replyEditor,
    name,
    meta,
    altResult: scan.result,
    lang,
  });
}
