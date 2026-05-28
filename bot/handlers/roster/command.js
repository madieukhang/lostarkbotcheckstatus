/**
 * handlers/roster/command.js
 * /la-roster: fetch a character's roster from lostark.bible. Visible
 * rosters render the alt list with iLvl + class; hidden rosters fall
 * back to the hidden-roster card with single-char data. Officer-only
 * `deep:true` opts into the Stronghold alt-detection scan.
 */

import { EmbedBuilder } from 'discord.js';
import { JSDOM, VirtualConsole } from 'jsdom';

const virtualConsole = new VirtualConsole();
virtualConsole.on('error', () => {});
virtualConsole.on('jsdomError', (err) => {
  if (err?.type === 'css parsing') return;
  console.warn('[jsdom] Parse warning:', err?.message || err);
});

import { connectDB } from '../../db.js';
import { COLORS } from '../../utils/ui.js';
import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import TrustedUser from '../../models/TrustedUser.js';
import RosterSnapshot from '../../models/RosterSnapshot.js';
import UserPreference from '../../models/UserPreference.js';
import {
  bibleClient,
  parseRosterCharactersFromHtml,
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
} from '../../services/roster/index.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { isPrivilegedStrongholdScanUser } from '../../utils/scanPermissions.js';
import { resolveDisplayImageUrl } from '../../utils/imageRehost.js';
import { rosterUrl } from '../../utils/rosterLink.js';
import { buildEvidenceEmbed } from '../list/view/ui.js';
import { decorateListEntry } from '../list/helpers.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { getClassEmoji } from '../../models/Class.js';
import { createLongRunningReplyEditor } from '../../utils/longRunningReply.js';
import { getUserLanguage } from '../../services/i18n/index.js';
import { reserveUserScan } from '../../utils/scanSession.js';
import { handleHiddenRosterResult } from './hiddenRoster.js';
import { runVisibleRosterDeepScan } from './visibleDeepScan.js';

function reserveCallerScan(interaction, label) {
  return reserveUserScan(interaction.user.id, {
    label,
    startedAt: Date.now(),
  }, {
    allowMultiple: isPrivilegedStrongholdScanUser(interaction.user.id),
  });
}

function buildScanLimitEmbed(active) {
  return buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    title: 'Scan Already Running',
    description: 'You already have a Stronghold scan running. Wait for it to finish or press **Stop scan** on the active card before starting another.',
    footer: active?.label ? `Active: ${active.label}` : undefined,
  });
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
    await interaction.reply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Officers / Seniors only',
        description:
          '`/la-roster deep:true` runs a long Stronghold scan that depends on the bot owner\'s ' +
          'residential-IP worker. The deep flag is restricted to officers and seniors. ' +
          'Re-run without `deep:true` for the basic roster view.',
      })],
      ephemeral: true,
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

  const scanReservation = deep ? reserveCallerScan(interaction, `/la-roster deep ${name}`) : null;
  if (scanReservation && !scanReservation.ok) {
    await interaction.reply({
      embeds: [buildScanLimitEmbed(scanReservation.active)],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply().catch((err) => {
    scanReservation?.release();
    throw err;
  });
  const replyEditor = createLongRunningReplyEditor(interaction);

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await bibleClient.fetch(targetUrl, deep ? { viaWorker: true } : {});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = new JSDOM(html, { virtualConsole }).window;
    const characters = await parseRosterCharactersFromHtml(html, document);

    if (characters.length === 0) {
      await handleHiddenRosterResult({ interaction, replyEditor, name, deep, deepOptions });
      return;
    }

    // Load previous snapshots for progression delta
    await connectDB();
    const prevSnapshots = new Map();
    const existingSnaps = await RosterSnapshot.find({
      name: { $in: characters.map((c) => c.name) },
    })
      .collation({ locale: 'en', strength: 2 })
      .lean();

    for (const snap of existingSnaps) {
      prevSnapshots.set(snap.name.toLowerCase(), snap);
    }

    const lines = characters.map((c, i) => {
      const prevSnap = prevSnapshots.get(c.name.toLowerCase());
      const currentIlvl = parseFloat((c.itemLevel ?? '0').replace(/,/g, ''));
      let delta = '';
      if (prevSnap && prevSnap.itemLevel > 0) {
        const diff = currentIlvl - prevSnap.itemLevel;
        if (diff > 0) delta = ` *(+${diff.toFixed(2)})*`;
        else if (diff < 0) delta = ` *(${diff.toFixed(2)})*`;
      }

      const cls = c.className || 'Unknown';
      const classPrefix = getClassEmoji(cls) || cls;
      return `**${i + 1}.** ${classPrefix} ${c.name} · \`${c.itemLevel}\`${delta} · ${c.combatScore}`;
    });

    let description = lines.join('\n');
    if (description.length > 4000) {
      description = description.slice(0, 4000) + '\n…';
    }

    // Save/update snapshots in background
    (async () => {
      for (const c of characters) {
        const ilvl = parseFloat((c.itemLevel ?? '0').replace(/,/g, ''));
        await RosterSnapshot.updateOne(
          { name: c.name },
          {
            $set: {
              itemLevel: ilvl,
              classId: c.classId || '',
              combatScore: c.combatScore || '',
              rosterName: name,
              updatedAt: new Date(),
            },
          },
          { upsert: true, collation: { locale: 'en', strength: 2 } }
        );
      }
    })().catch((err) => console.warn('[roster] Snapshot save failed:', err.message));

    const charNames = characters
      .filter((c) => parseFloat((c.itemLevel ?? '0').replace(/,/g, '')) >= 1700)
      .map((c) => c.name);

    const [blacklistResult, whitelistResult, trustedResult] = await Promise.all([
      handleRosterBlackListCheck(charNames, { guildId: interaction.guild?.id }),
      handleRosterWhiteListCheck(charNames),
      TrustedUser.findOne({ name: { $in: charNames } }).collation({ locale: 'en', strength: 2 }).lean(),
    ]);

    const embedColor = blacklistResult ? COLORS.danger : whitelistResult ? COLORS.success : trustedResult ? COLORS.trustedSoft : COLORS.info;

    // Top-of-description summary: highest ilvl + total CP if available.
    // Gives the reader an at-a-glance read on the roster's max gear
    // without parsing the full character list.
    const topChar = characters[0];
    const topIlvl = topChar?.itemLevel || '?';
    const topClass = topChar?.className || topChar?.classId || '?';
    const topClassPrefix = getClassEmoji(topClass) || topClass;
    const summaryLine = topChar
      ? `Top character: ${topClassPrefix} **${topChar.name}** · \`${topIlvl}\``
      : '';

    const fullDescription = summaryLine
      ? `${summaryLine}\n\n${description}`.slice(0, 4096)
      : description;

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ ${name}'s Roster · ${characters.length} character${characters.length === 1 ? '' : 's'}`)
      // Display URL goes through the helper so BIBLE_BASE_URL swaps cascade
      // here too. targetUrl above is intentionally still hardcoded · it's
      // the actual fetch endpoint, controlled by the scraper/worker layer.
      .setURL(rosterUrl(name))
      .setDescription(fullDescription)
      .setColor(embedColor)
      .setFooter({ text: 'Source: lostark.bible · re-run /la-roster to refresh' })
      .setTimestamp();

    const embeds = [embed];
    const contentLines = [];

    if (trustedResult) {
      contentLines.push(`🛡️ **${trustedResult.name}** is a trusted user.${trustedResult.reason ? ` · *${trustedResult.reason}*` : ''}`);
    }

    if (blacklistResult) {
      const reason = blacklistResult.reason ? ` · *${blacklistResult.reason}*` : '';
      const raid = blacklistResult.raid ? ` [${blacklistResult.raid}]` : '';
      contentLines.push(`⛔ **${name}** is on the blacklist.${raid}${reason}`);

      // Use the shared buildEvidenceEmbed so the inline evidence card
      // matches /la-evidence, /la-search, /la-list view, /la-check.
      // Was a title+image-only embed before · officer reviewing a
      // /la-roster hit would see less context than they would elsewhere.
      const blackImageUrl = await resolveDisplayImageUrl(blacklistResult, interaction.client);
      if (blackImageUrl) {
        embeds.unshift(buildEvidenceEmbed(decorateListEntry(blacklistResult, 'black'), blackImageUrl));
      }
    }

    if (whitelistResult) {
      const reason = whitelistResult.reason ? ` · *${whitelistResult.reason}*` : '';
      const raid = whitelistResult.raid ? ` [${whitelistResult.raid}]` : '';
      contentLines.push(`✅ **${name}** is on the whitelist.${raid}${reason}`);

      const whiteImageUrl = await resolveDisplayImageUrl(whitelistResult, interaction.client);
      if (whiteImageUrl) {
        embeds.unshift(buildEvidenceEmbed(decorateListEntry(whitelistResult, 'white'), whiteImageUrl));
      }
    }

    const visibleDeep = deep
      ? await runVisibleRosterDeepScan({ interaction, replyEditor, name, deepOptions, embed, contentLines })
      : { resultEmbed: null, components: [], result: null, meta: null };

    const content = contentLines.length > 0 ? contentLines.join('\n') : undefined;

    if (visibleDeep.resultEmbed) embeds.push(visibleDeep.resultEmbed);
    await replyEditor.edit({ content, embeds, components: visibleDeep.components });

    // DM the caller when a deep scan was actually run (skip plain
    // /la-roster which finishes in seconds and doesn't warrant a
    // notification ping).
    if (deep && visibleDeep.result) {
      const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
      const replyMsg = replyEditor.getMessage();
      let outcome;
      if (visibleDeep.result.cancelled || visibleDeep.result.pausedForFailureStorm) {
        outcome = visibleDeep.result.alts.length > 0 ? 'stopped-with-alts' : 'stopped-no-alts';
      } else {
        outcome = visibleDeep.result.alts.length > 0 ? 'completed' : 'no-alts';
      }
      sendScanCompletionDm({
        user: interaction.user,
        commandLabel: '/la-roster deep',
        scanTargetName: name,
        guildName: visibleDeep.meta?.guildName,
        channelMention: interaction.channelId ? `<#${interaction.channelId}>` : undefined,
        resultMessageUrl: buildResultMessageUrl(interaction, replyMsg),
        outcome,
        result: visibleDeep.result,
        lang,
      }).catch(() => {});
    }
  } catch (err) {
    await replyEditor.edit({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Roster Fetch Failed',
        description: 'Could not fetch the roster from lostark.bible.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      })],
    });
  } finally {
    scanReservation?.release();
  }
}
