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
import Watchlist from '../../models/Watchlist.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import UserPreference from '../../models/UserPreference.js';
import { CASE_INSENSITIVE_COLLATION } from '../../models/collation.js';
import {
  bibleClient,
  parseCharacterMetaFromHtml,
  parseRosterCharactersFromHtml,
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
  stampRosterWorld,
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
import { MIN_TRACKED_ITEM_LEVEL } from '../../config/itemLevelThreshold.js';
import { getListContext } from '../list/helpers.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { getClassEmoji } from '../../models/Class.js';
import { createLongRunningReplyEditor } from '../../utils/longRunningReply.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { handleHiddenRosterResult } from './hiddenRoster.js';
import { buildDeepScanNotRunNotice } from './deepResult.js';
import { runVisibleRosterDeepScan } from './visibleDeepScan.js';
import { resolveRosterScanOutcome } from './completion.js';
import { buildRosterEvidenceRows } from './evidenceButton.js';

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
  // The server belongs to the roster; carrying it on each character lets the
  // cards built from them show it without threading a separate argument
  // through every builder.
  const characters = await parseRosterCharactersFromHtml(html, document);
  return {
    characters: stampRosterWorld(characters, world),
    world,
  };
}

async function loadPreviousSnapshotMap(characters) {
  const snapshots = await RosterSnapshot.find({
    name: { $in: characters.map((character) => character.name) },
  })
    .collation(CASE_INSENSITIVE_COLLATION)
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

/** Load visible-roster list matches without fetching additional Bible pages. */
export async function loadVisibleRosterMatches(characters, guildId, {
  checkBlacklist = handleRosterBlackListCheck,
  checkWhitelist = handleRosterWhiteListCheck,
  WatchlistModel = Watchlist,
  TrustedUserModel = TrustedUser,
} = {}) {
  const checkNames = characters
    .filter((character) => parseItemLevel(character.itemLevel) >= MIN_TRACKED_ITEM_LEVEL)
    .map((character) => character.name);
  const [blacklist, whitelist, watchlist, trusted] = await Promise.all([
    checkBlacklist(checkNames, { guildId }),
    checkWhitelist(checkNames),
    WatchlistModel.findOne(buildNameRosterQuery(checkNames))
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean(),
    TrustedUserModel.findOne(buildNameRosterQuery(checkNames))
      .collation(CASE_INSENSITIVE_COLLATION)
      .lean(),
  ]);
  return { blacklist, whitelist, watchlist, trusted };
}

/** Use the highest-severity roster match for the card's status color. */
export function rosterCardColor(matches) {
  const rules = [
    { matches: () => matches.blacklist, color: COLORS.danger },
    { matches: () => matches.watchlist, color: COLORS.warning },
    { matches: () => matches.whitelist, color: COLORS.success },
    { matches: () => matches.trusted, color: COLORS.trustedSoft },
    { matches: () => true, color: COLORS.info },
  ];
  return rules.find(({ matches: matchesRule }) => matchesRule()).color;
}

/** List hits in the severity order rosterCardColor ranks them. */
function collectListHits(matches) {
  return [
    ['black', matches.blacklist],
    ['watch', matches.watchlist],
    ['white', matches.whitelist],
  ].filter(([, entry]) => entry).map(([listType, entry]) => ({ listType, entry }));
}

function formatStatusLine(icon, text, reason) {
  return `${icon} ${text}${reason ? ` · *${reason}*` : ''}`;
}

/**
 * Render the visible roster. Each list hit is one status line on the card
 * and one button that opens its full report; trusted status stays a line.
 * @param {object} params
 * @param {object[]} params.characters - roster characters from lostark.bible
 * @param {Map<string, object>} params.previousSnapshots - earlier stats by lowercase name
 * @param {{blacklist?: object, watchlist?: object, whitelist?: object, trusted?: object}} params.matches
 * @param {string} params.name - the searched character
 * @param {string} params.lang
 * @param {string} [params.world] - in-game server, when bible reported one
 * @returns {{embed: import('discord.js').EmbedBuilder, embeds: import('discord.js').EmbedBuilder[],
 *   evidenceRows: import('discord.js').ActionRowBuilder[]}}
 */
export function buildVisibleRosterPresentation({ characters, previousSnapshots, matches, name, lang, world = '' }) {
  const fullDescription = buildRosterDescription(characters, previousSnapshots, lang, world);
  const hits = collectListHits(matches);
  const statusLines = hits.map(({ listType, entry }) => formatStatusLine(
    getListContext(listType).icon,
    `**${t(`listView.labels.${listType}`, lang)}:** **${entry.name}**`,
    entry.reason,
  ));
  if (matches.trusted) {
    statusLines.push(formatStatusLine(
      '🛡️',
      t('dialogue.roster.trusted', lang, { name: matches.trusted.name }),
      matches.trusted.reason,
    ));
  }
  const status = statusLines.join('\n');
  const description = status
    ? [status, fullDescription.slice(0, Math.max(0, 4096 - status.length - 2))].join('\n\n')
    : fullDescription;

  const embed = createArtistEmbed()
    .setTitle(`🛡️ ${t('dialogue.roster.title', lang, {
      name,
      count: characters.length,
      word: t(`dialogue.roster.${characters.length === 1 ? 'characterOne' : 'characterMany'}`, lang),
    })}`)
    .setURL(rosterUrl(name))
    .setDescription(description)
    .setColor(rosterCardColor(matches));

  return { embed, embeds: [embed], evidenceRows: buildRosterEvidenceRows(hits, lang) };
}

function notifyVisibleDeepCompletion({ interaction, replyEditor, visibleDeep, name, lang }) {
  const outcome = resolveRosterScanOutcome(visibleDeep.result, { hasRemaining: visibleDeep.resumable });
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

async function handleVisibleRosterResult({ interaction, guildId, replyEditor, name, deep, deepOptions, characters, lang, world = '' }) {
  await connectDB();
  const previousSnapshotsPromise = loadPreviousSnapshotMap(characters).then(previousSnapshots => {
    // Capture old stats before writing; list lookup failure must not prevent
    // a successful roster fetch from refreshing its snapshots.
    upsertRosterSnapshots(characters, name)
      .catch((err) => console.warn('[roster] Snapshot save failed:', err.message));
    return previousSnapshots;
  });
  const [previousSnapshots, matches] = await Promise.all([
    previousSnapshotsPromise,
    loadVisibleRosterMatches(characters, guildId).catch((err) => {
      err.rosterStage = 'list-check';
      throw err;
    }),
  ]);
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

  if (visibleDeep.resultEmbed) {
    presentation.embeds.push(visibleDeep.resultEmbed);
  } else if (deep) {
    presentation.embeds.push(buildDeepScanNotRunNotice({
      name,
      meta: visibleDeep.meta,
      guildMembersUnavailable: visibleDeep.guildMembersUnavailable,
      lang,
    }));
  }
  await replyEditor.edit({
    content: null,
    embeds: presentation.embeds,
    components: [...presentation.evidenceRows, ...(visibleDeep.components || [])].slice(0, 5),
  });
  notifyVisibleDeepCompletion({ interaction, replyEditor, visibleDeep, name, lang });
}

// Alert copy by the stage tagged on a failure; an untagged failure happened
// while fetching the roster from lostark.bible.
const ROSTER_FAILURE_ALERT_KEYS = Object.freeze({
  'list-check': 'dialogue.roster.listCheckFailed',
});

/**
 * Run the shared roster lookup after the slash or channel request is
 * acknowledged. Fetch and list failures are reported on `replyEditor`, not thrown.
 * @param {object} request
 * @param {import('discord.js').Interaction} [request.interaction] - slash
 *   command; supplies the language and guild when `lang` and `guildId` are
 *   not given, and is required for a deep scan
 * @param {string} [request.guildId] - scope for the list lookup; defaults to
 *   the interaction's guild
 * @param {{edit: Function}} request.replyEditor - receives the result card or failure notice
 * @param {string} request.name - normalized character name
 * @param {boolean} [request.deep=false] - opt into the Stronghold alt scan
 * @param {object} [request.deepOptions] - forwarded to the deep scan
 * @param {string} [request.lang] - resolved locale; read from the interaction
 *   user's preference when omitted
 * @param {object} [deps] - replaceable steps for tests
 * @param {Function} [deps.fetchRoster] - `(name, deep) => {characters, world}`
 * @param {Function} [deps.renderVisible] - renders a roster with characters
 * @param {Function} [deps.renderHidden] - renders a roster without characters;
 *   resolving to `false` reports that no profile card was shown for the name
 * @returns {Promise<boolean>} false when the lookup failed or Bible has no
 *   profile for the name; true otherwise
 */
export async function runRosterLookup({
  interaction,
  guildId = interaction?.guild?.id,
  replyEditor,
  name,
  deep = false,
  deepOptions = {},
  lang: requestedLang,
}, {
  fetchRoster = fetchRosterCharacters,
  renderVisible = handleVisibleRosterResult,
  renderHidden = handleHiddenRosterResult,
} = {}) {
  const languagePromise = requestedLang
    ? Promise.resolve(requestedLang)
    : getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
  try {
    const [lang, { characters, world }] = await Promise.all([
      languagePromise,
      fetchRoster(name, deep),
    ]);
    const render = characters.length === 0 ? renderHidden : renderVisible;
    const rendered = await render({ interaction, guildId, replyEditor, name, deep, deepOptions, characters, lang, world });
    return rendered !== false;
  } catch (err) {
    const lang = await languagePromise;
    await replyEditor.edit({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        ...t(ROSTER_FAILURE_ALERT_KEYS[err?.rosterStage] || 'dialogue.roster.fetchFailed', lang),
        fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
        lang,
      })],
    });
    return false;
  }
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

  // Hard gate: deep scans hit the bot owner's residential-IP worker.
  // Plain /la-roster (no deep) stays open to everyone since it only
  // does a single-page roster fetch with no fan-out.
  if (deep && !isPrivilegedStrongholdScanUser(interaction.user.id)) {
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
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
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    await replyEmbed(interaction, buildStrongholdScanLimitEmbed(scanReservation.active, lang));
    return;
  }

  await deferReply(interaction).catch((err) => {
    scanReservation?.release();
    throw err;
  });
  const replyEditor = createLongRunningReplyEditor(interaction);
  try {
    await runRosterLookup({ interaction, replyEditor, name, deep, deepOptions });
  } finally {
    scanReservation?.release();
  }
}
