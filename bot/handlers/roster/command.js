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
import {
  fetchWithFallback,
  parseRosterCharactersFromHtml,
  handleRosterBlackListCheck,
  handleRosterWhiteListCheck,
} from '../../services/rosterService.js';
import { normalizeCharacterName } from '../../utils/names.js';
import { resolveDisplayImageUrl } from '../../utils/imageRehost.js';
import { sendScanCompletionDm, buildResultMessageUrl } from '../../utils/scanCompletionDm.js';
import { handleHiddenRosterResult } from './hiddenRoster.js';
import { runVisibleRosterDeepScan } from './visibleDeepScan.js';

export async function handleRosterCommand(interaction) {
  const raw = interaction.options.getString('name');
  const name = normalizeCharacterName(raw);
  const deep = interaction.options.getBoolean('deep') ?? false;
  const deepLimit = interaction.options.getInteger('deep_limit');
  // ScraperAPI is intentionally locked off for the per-candidate scan
  // because that is the high-fanout (300+ requests) path that would burn
  // quota fast. Single-request meta + guild fetches inside the detector
  // (when targetMeta / guildMembers are NOT pre-supplied) still allow
  // ScraperAPI fallback - same rationale as the pre-flight probes below.
  const deepOptions = {
    ...(deepLimit !== null ? { candidateLimit: deepLimit } : {}),
    useScraperApiForCandidates: false,
  };
  await interaction.deferReply();

  try {
    const targetUrl = `https://lostark.bible/character/NA/${encodeURIComponent(name)}/roster`;
    const response = await fetchWithFallback(targetUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const { document } = new JSDOM(html, { virtualConsole }).window;
    const characters = await parseRosterCharactersFromHtml(html, document);

    if (characters.length === 0) {
      await handleHiddenRosterResult({ interaction, name, deep, deepOptions });
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

      return `**${i + 1}.** ${c.name} · ${c.className || 'Unknown'} · \`${c.itemLevel}\`${delta} · ${c.combatScore}`;
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
    const summaryLine = topChar
      ? `Top character: **${topChar.name}** · ${topClass} · \`${topIlvl}\``
      : '';

    const fullDescription = summaryLine
      ? `${summaryLine}\n\n${description}`.slice(0, 4096)
      : description;

    const embed = new EmbedBuilder()
      .setTitle(`🛡️ ${name}'s Roster · ${characters.length} character${characters.length === 1 ? '' : 's'}`)
      .setURL(targetUrl)
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

      // Resolve fresh URL for rehosted entries; legacy entries use stored URL.
      const blackImageUrl = await resolveDisplayImageUrl(blacklistResult, interaction.client);
      if (blackImageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Blacklist Evidence')
          .setImage(blackImageUrl)
          .setColor(COLORS.danger);
        embeds.unshift(evidenceEmbed);
      }
    }

    if (whitelistResult) {
      const reason = whitelistResult.reason ? ` · *${whitelistResult.reason}*` : '';
      const raid = whitelistResult.raid ? ` [${whitelistResult.raid}]` : '';
      contentLines.push(`✅ **${name}** is on the whitelist.${raid}${reason}`);

      const whiteImageUrl = await resolveDisplayImageUrl(whitelistResult, interaction.client);
      if (whiteImageUrl) {
        const evidenceEmbed = new EmbedBuilder()
          .setTitle('Whitelist Evidence')
          .setImage(whiteImageUrl)
          .setColor(COLORS.success);
        embeds.unshift(evidenceEmbed);
      }
    }

    const visibleDeep = deep
      ? await runVisibleRosterDeepScan({ interaction, name, deepOptions, embed, contentLines })
      : { resultEmbed: null, components: [], result: null, meta: null };

    const content = contentLines.length > 0 ? contentLines.join('\n') : undefined;

    if (visibleDeep.resultEmbed) embeds.push(visibleDeep.resultEmbed);
    await interaction.editReply({ content, embeds, components: visibleDeep.components });

    // DM the caller when a deep scan was actually run (skip plain
    // /la-roster which finishes in seconds and doesn't warrant a
    // notification ping).
    if (deep && visibleDeep.result) {
      const replyMsg = await interaction.fetchReply().catch(() => null);
      let outcome;
      if (visibleDeep.result.cancelled) {
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
      }).catch(() => {});
    }
  } catch (err) {
    await interaction.editReply({
      embeds: [buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Roster Fetch Failed',
        description: 'Could not fetch the roster from lostark.bible.',
        fields: [{ name: 'Error', value: `\`${err.message}\``, inline: false }],
      })],
    });
  }
}
