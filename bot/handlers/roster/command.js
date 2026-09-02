/**
 * handlers/roster/command.js
 * /la-roster: fetch a character's roster from lostark.bible. Visible
 * rosters render the alt list with iLvl + class; hidden rosters fall
 * back to the hidden-roster card with single-char data. Officer-only
 * `deep:true` opts into the Stronghold alt-detection scan.
 */

import { createArtistEmbed } from '../../utils/artistVoice.js';
import { JSDOM } from 'jsdom';
import { createRosterVirtualConsole } from '../../services/roster/dom.js';
import { connectDB } from '../../db.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { deferReply, replyAlert, replyEmbed } from '../../utils/interactionReplies.js';
import TrustedUser from '../../models/TrustedUser.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import UserPreference from '../../models/UserPreference.js';
import {
  bibleClient,
  parseCharacterMetaFromHtml,
  parseRosterCharactersFromHtml,
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
  upsertRosterSnapshots,
} from '../../services/roster/index.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { buildNameRosterQuery } from '../../utils/listEntryMap.js';
import { isPrivilegedStrongholdScanUser } from '../../utils/scanPermissions.js';
import {
  buildStrongholdScanLimitEmbed,
  reserveStrongholdScanForInteraction,
} from '../../utils/strongholdScanGate.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildEvidenceEmbed } from '../list/view/ui.js';
import { buildBroadcastEvidenceComponents } from '../list/evidence/broadcastButton.js';
import { decorateListEntry } from '../list/helpers.js';
import { statMapFromRosterCharacters } from '../list/trackedAltsRender.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { getClassEmoji } from '../../models/Class.js';
import { createLongRunningReplyEditor } from '../../utils/longRunningReply.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { handleHiddenRosterResult } from './hiddenRoster.js';
import { runVisibleRosterDeepScan } from './visibleDeepScan.js';
import { resolveRosterScanOutcome } from './completion.js';

const virtualConsole = createRosterVirtualConsole();

/**
 * Render one visible-roster row. Both numeric stats use Discord code badges;
 * CP keeps the approximation marker from lostark.bible and carries its unit
 * after the value so the row reads `≈6180.57 CP`.
 */
export function formatVisibleRosterLine(character, index, {
  classPrefix,
  delta = '',
} = {}) {
  return `**${index + 1}.** ${classPrefix} ${character.name} · \`${character.itemLevel}\`${delta} · \`${character.combatScore} CP\``;
}

function parseItemLevel(value) {
  return Number.parseFloat(String(value ?? '0').replace(/,/g, ''));
}

export function formatItemLevelDelta(currentItemLevel, previousItemLevel) {
  const previous = Number(previousItemLevel) || 0;
  if (previous <= 0) return '';

  const diff = parseItemLevel(currentItemLevel) - previous;
  if (diff === 0) return '';
  return ` *(${diff > 0 ? '+' : ''}${diff.toFixed(2)})*`;
}

export function buildVisibleRosterLines(characters, previousSnapshots, lang = 'en') {
  return characters.map((character, index) => {
    const previous = previousSnapshots.get(character.name.toLowerCase());
    const className = character.className || t('dialogue.common.unknown', lang);
    return formatVisibleRosterLine(character, index, {
      classPrefix: getClassEmoji(className) || className,
      delta: formatItemLevelDelta(character.itemLevel, previous?.itemLevel),
    });
  });
}

async function fetchRosterCharacters(name, deep) {
  const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
  const response = await bibleClient.fetch(targetUrl, deep ? { viaWorker: true } : {});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const html = await response.text();
  const { document } = new JSDOM(html, { virtualConsole }).window;
  // The in-game server rides in the same SSR payload this page already
  // carries, so reading it here costs nothing extra.
  const world = parseCharacterMetaFromHtml(html)?.world || '';
  // Stamped onto every record, the way buildRosterCharacters does it ·
  // the server belongs to the roster, so carrying it on the characters
  // themselves is what lets the cards built from them show it without
  // threading a separate argument through every builder.
  const characters = await parseRosterCharactersFromHtml(html, document);
  return {
    characters: world ? characters.map((c) => ({ ...c, world })) : characters,
    world,
  };
}

async function loadPreviousSnapshotMap(characters) {
  await connectDB();
  const snapshots = await RosterSnapshot.find({
    name: { $in: characters.map((character) => character.name) },
  })
    .collation({ locale: 'en', strength: 2 })
    .lean();
  return new Map(snapshots.map((snapshot) => [snapshot.name.toLowerCase(), snapshot]));
}

function buildRosterDescription(characters, previousSnapshots, lang, world = '') {
  const lines = buildVisibleRosterLines(characters, previousSnapshots, lang);
  const rosterLines = lines.join('\n');
  const description = rosterLines.length > 4000
    ? `${rosterLines.slice(0, 4000)}\n…`
    : rosterLines;
  const topCharacter = characters[0];
  if (!topCharacter) return description;

  const topClass = topCharacter.className || topCharacter.classId || '?';
  const header = [
    // The in-game server, when bible reported one. This bot is used
    // across servers, so "which one is this" is the first thing a reader
    // needs before the names mean anything.
    world ? `🌍 **${t('dialogue.roster.server', lang)}:** \`${world}\`` : '',
    t('dialogue.roster.topCharacter', lang, {
      class: getClassEmoji(topClass) || topClass,
      name: topCharacter.name,
      ilvl: topCharacter.itemLevel || '?',
    }),
  ].filter(Boolean).join('\n');
  return `${header}\n\n${description}`.slice(0, 4096);
}

async function loadVisibleRosterMatches(characters, guildId) {
  const checkNames = characters
    .filter((character) => parseItemLevel(character.itemLevel) >= 1700)
    .map((character) => character.name);
  const [blacklist, whitelist, trusted] = await Promise.all([
    handleRosterBlackListCheck(checkNames, { guildId }),
    handleRosterWhiteListCheck(checkNames),
    TrustedUser.findOne(buildNameRosterQuery(checkNames))
      .collation({ locale: 'en', strength: 2 })
      .lean(),
  ]);
  return { blacklist, whitelist, trusted };
}

export function rosterCardColor(matches) {
  const rules = [
    { matches: () => matches.blacklist, color: COLORS.danger },
    { matches: () => matches.whitelist, color: COLORS.success },
    { matches: () => matches.trusted, color: COLORS.trustedSoft },
    { matches: () => true, color: COLORS.info },
  ];
  return rules.find(({ matches: matchesRule }) => matchesRule()).color;
}

function prependEvidenceCards({ embeds, rows, matches, statMap, name, lang }) {
  for (const [listType, entry] of [['black', matches.blacklist], ['white', matches.whitelist]]) {
    if (!entry) continue;
    embeds.unshift(buildEvidenceEmbed(decorateListEntry(entry, listType), '', {
      lang,
      statMap,
      headline: true,
      attachImage: false,
      viaName: name,
    }));
    rows.unshift(...buildBroadcastEvidenceComponents(entry, {
      legacyUrl: entry.imageUrl,
      lang,
    }));
  }
}

function buildVisibleRosterPresentation({ characters, previousSnapshots, matches, name, lang, world = '' }) {
  const fullDescription = buildRosterDescription(characters, previousSnapshots, lang, world);
  const embed = createArtistEmbed(lang)
    .setTitle(`🛡️ ${t('dialogue.roster.title', lang, {
      name,
      count: characters.length,
      word: t(`dialogue.roster.${characters.length === 1 ? 'characterOne' : 'characterMany'}`, lang),
    })}`)
    .setURL(rosterUrl(name))
    .setDescription(fullDescription)
    .setColor(rosterCardColor(matches));

  if (matches.trusted) {
    const status = `🛡️ ${t('dialogue.roster.trusted', lang, { name: matches.trusted.name })}`
      + (matches.trusted.reason ? ` · *${matches.trusted.reason}*` : '');
    const remaining = Math.max(0, 4096 - status.length - 2);
    embed.setDescription([status, fullDescription.slice(0, remaining)].join('\n\n'));
  }

  const embeds = [embed];
  const evidenceRows = [];
  prependEvidenceCards({
    embeds,
    rows: evidenceRows,
    matches,
    statMap: statMapFromRosterCharacters(characters),
    name,
    lang,
  });
  return { embed, embeds, evidenceRows };
}

function notifyVisibleDeepCompletion({ interaction, replyEditor, visibleDeep, name, lang }) {
  const outcome = resolveRosterScanOutcome(visibleDeep.result);
  if (!outcome) return;

  sendScanCompletionDm({
    user: interaction.user,
    commandLabel: '/la-roster deep',
    scanTargetName: name,
    guildName: visibleDeep.meta?.guildName,
    channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
    resultMessageUrl: buildResultMessageUrl(interaction, replyEditor.getMessage()),
    outcome,
    result: visibleDeep.result,
    lang,
  }).catch(() => {});
}

async function handleVisibleRosterResult({ interaction, replyEditor, name, deep, deepOptions, characters, lang, world = '' }) {
  const previousSnapshots = await loadPreviousSnapshotMap(characters);
  // Records already carry the server · fetchRosterCharacters stamps it.
  upsertRosterSnapshots(characters, name)
    .catch((err) => console.warn('[roster] Snapshot save failed:', err.message));

  const matches = await loadVisibleRosterMatches(characters, interaction.guild?.id);
  const presentation = buildVisibleRosterPresentation({
    characters,
    previousSnapshots,
    matches,
    name,
    lang,
    world,
  });
  const visibleDeep = deep
    ? await runVisibleRosterDeepScan({
      interaction,
      replyEditor,
      name,
      deepOptions,
      embed: presentation.embed,
    })
    : { resultEmbed: null, components: [], result: null, meta: null };

  if (visibleDeep.resultEmbed) presentation.embeds.push(visibleDeep.resultEmbed);
  await replyEditor.edit({
    content: null,
    embeds: presentation.embeds,
    components: [...presentation.evidenceRows, ...(visibleDeep.components || [])].slice(0, 5),
  });
  notifyVisibleDeepCompletion({ interaction, replyEditor, visibleDeep, name, lang });
}

/**
 * Handle the /la-roster slash command.
 * Branches on `rosterVisibility` returned by buildRosterCharacters:
 * visible → render visible-roster embed (alt list + iLvl + class),
 * hidden → delegate to handleHiddenRosterResult, missing → not-found
 * card. When `deep:true` and the roster is visible, opts into
 * runVisibleRosterDeepScan for Stronghold-based alt detection.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<void>}
 */
export async function handleRosterCommand(interaction) {
  const raw = interaction.options.getString('name');
  const name = normalizeCharacterName(raw);
  const deep = interaction.options.getBoolean('deep') ?? false;
  const deepLimit = interaction.options.getInteger('deep_limit');
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });

  // Hard gate: deep scans hit the bot owner's residential-IP worker.
  // Plain /la-roster (no deep) stays open to everyone since it only
  // does a single-page roster fetch with no fan-out.
  if (deep && !isPrivilegedStrongholdScanUser(interaction.user.id)) {
    await replyAlert(interaction, {
      severity: AlertSeverity.WARNING,
      ...t('dialogue.roster.deepRestricted', lang),
      lang,
    });
    return;
  }

  // ScraperAPI is intentionally locked off for the per-candidate scan
  // because that is the high-fanout (300+ requests) path that would burn
  // quota fast. Single-request meta + guild fetches inside the detector
  // (when targetMeta / guildMembers are NOT pre-supplied) still allow
  // ScraperAPI fallback - same rationale as the pre-flight probes below.
  const deepOptions = {
    ...(deepLimit !== null ? { candidateLimit: deepLimit } : {}),
    useScraperApiForCandidates: false,
  };

  const scanReservation = deep ? reserveStrongholdScanForInteraction(interaction, `/la-roster deep ${name}`) : null;
  if (scanReservation && !scanReservation.ok) {
    await replyEmbed(interaction, buildStrongholdScanLimitEmbed(scanReservation.active, lang));
    return;
  }

  await deferReply(interaction).catch((err) => {
    scanReservation?.release();
    throw err;
  });
  const replyEditor = createLongRunningReplyEditor(interaction);

  try {
    const { characters, world } = await fetchRosterCharacters(name, deep);

    if (characters.length === 0) {
      await handleHiddenRosterResult({ interaction, replyEditor, name, deep, deepOptions });
      return;
    }
    await handleVisibleRosterResult({
      interaction,
      replyEditor,
      name,
      deep,
      deepOptions,
      characters,
      lang,
      world,
    });
  } catch (err) {
    await replyEditor.edit({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        ...t('dialogue.roster.fetchFailed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      })],
    });
  } finally {
    scanReservation?.release();
  }
}
