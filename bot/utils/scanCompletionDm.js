/**
 * scanCompletionDm.js
 *
 * Best-effort DM notification when a long-running stronghold scan
 * finishes. Used by /la-list enrich and /la-roster deep:true so the
 * caller doesn't have to keep the channel open through a 10-15 min
 * scan; the DM lands in their tray with the result + a "Jump to
 * result" link back to the channel reply.
 *
 * Failures are logged and swallowed because callers are mid-flow on
 * the original interaction reply and shouldn't fail just because the
 * user has DMs disabled.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';

import { COLORS, ICONS } from './ui.js';
import { rosterUrl } from './rosterLink.js';
import { getClassEmoji } from '../models/Class.js';
import { t } from '../services/i18n/index.js';

/**
 * @typedef ScanDmOptions
 * @property {import('discord.js').User} user - The slash command caller (interaction.user).
 * @property {string} commandLabel - "/la-list enrich" or "/la-roster deep:true".
 * @property {string} scanTargetName - Character name the scan ran against.
 * @property {string} [guildName] - Bible-side guild name; rendered as context.
 * @property {string} [channelMention] - "<#channelId>" so the DM links the channel.
 * @property {string} [resultMessageUrl] - Discord message URL to attach as a Link button.
 * @property {string} [lang='en'] - Display language for interactive controls.
 * @property {'completed'|'no-alts'|'stopped-with-alts'|'stopped-no-alts'|'enrich-saved'} outcome
 * @property {object} [result] - Scan result: { scannedCandidates, failedCandidates, alts? }
 * @property {Array} [alts] - Optional override for the alt list (use this when
 *   the caller has filtered the alts down to "new only" before DM).
 */

const OUTCOME_STYLE = {
  'completed':         { icon: ICONS.done,   headline: 'Scan complete',        color: 'success' },
  'enrich-saved':      { icon: ICONS.done,   headline: 'Saved to entry',       color: 'success' },
  'no-alts':           { icon: ICONS.search, headline: 'Scan finished · 0 alts', color: 'info'    },
  'stopped-with-alts': { icon: '🛑',         headline: 'Stopped (partial)',    color: 'warning' },
  'stopped-no-alts':   { icon: '🛑',         headline: 'Stopped · 0 alts',     color: 'muted'   },
};

function pickColor(token) {
  return COLORS[token] ?? COLORS.info;
}

/**
 * Render the alt list block. Each row carries class + ilvl so the DM
 * is useful as a standalone artifact: an officer who clears their DM
 * tray six hours later can still tell at a glance which class /
 * ilvl bucket each alt falls into without re-running the command.
 */
function buildAltLines(alts = []) {
  if (!alts.length) return '';
  const visible = alts.slice(0, 10);
  const lines = visible.map((alt, i) => {
    const link = rosterUrl(alt.name);
    const cls = alt.className || alt.classId || '?';
    const classPrefix = getClassEmoji(cls) || cls;
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    return `**${i + 1}.** ${classPrefix} [${alt.name}](${link}) · \`${ilvl}\``;
  });
  const extra = alts.length > visible.length
    ? `\n*... and ${alts.length - visible.length} more*`
    : '';
  return `\n\n**🎯 Matches (${alts.length}):**\n${lines.join('\n')}${extra}`;
}

/**
 * @param {ScanDmOptions} opts
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function sendScanCompletionDm(opts) {
  const {
    user,
    commandLabel,
    scanTargetName,
    guildName,
    channelMention,
    resultMessageUrl,
    lang = 'en',
    outcome,
    result = {},
    alts: altsOverride,
  } = opts;

  const style = OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE.completed;
  const alts = altsOverride ?? result.alts ?? [];
  const altsBlock = buildAltLines(alts);

  // DM description has 3 visual blocks separated by blank lines:
  //   1. Hero line with command + channel link
  //   2. Source context (guild name)
  //   3. Alt list (when matches exist)
  // Anything technical (counts, retries, ScraperAPI) goes into the
  // addFields stats grid below — keeps the description tight.
  const heroLines = [];
  heroLines.push(
    `Your \`${commandLabel}\` scan${channelMention ? ` in ${channelMention}` : ''} just finished.`
  );
  if (guildName) {
    heroLines.push('');
    heroLines.push(`📍 Guild: **${guildName}**`);
  }

  const checkedCandidates = result.checkedCandidates ?? result.scannedCandidates ?? 0;
  const attemptedCandidates = result.attemptedCandidates ?? result.scannedCandidates ?? 0;
  const statFields = [
    { name: '🔍 Checked', value: String(checkedCandidates), inline: true },
    { name: '🎯 Found', value: String(alts.length), inline: true },
    { name: '⚠️ Failed', value: String(result.failedCandidates ?? 0), inline: true },
  ];
  if (attemptedCandidates > checkedCandidates) {
    statFields.push({
      name: '🔁 Attempts',
      value: String(attemptedCandidates),
      inline: true,
    });
  }
  if ((result.scraperApiRequests ?? 0) > 0) {
    statFields.push({
      name: '🌐 ScraperAPI',
      value: String(result.scraperApiRequests),
      inline: true,
    });
  }
  if (result.abortLabel) {
    // Abort details deserve a full-width line because the explanation
    // can run long ("Bible 503 storm: 78% failure across 120 attempts").
    statFields.push({
      name: '🛑 Stop reason',
      value: String(result.abortLabel).slice(0, 1024),
      inline: false,
    });
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Lost Ark Check · Scan notification' })
    .setTitle(`${style.icon}  ${style.headline} · ${scanTargetName}`)
    .setDescription(heroLines.join('\n') + altsBlock)
    .setColor(pickColor(style.color))
    .addFields(...statFields)
    .setFooter({ text: 'You started the command, so I sent you the heads-up. Block the bot if these DMs are unwanted.' })
    .setTimestamp();

  const components = [];
  if (resultMessageUrl) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(t('common.actions.jumpToResult', lang))
          .setStyle(ButtonStyle.Link)
          .setURL(resultMessageUrl)
      )
    );
  }

  try {
    await user.send({ embeds: [embed], components });
    return { ok: true };
  } catch (err) {
    console.warn(`[scan-dm] DM to ${user?.id || 'unknown'} failed:`, err?.message || err);
    return { ok: false, error: err?.message };
  }
}

/**
 * Convenience helper: build a Discord message URL from interaction +
 * the message returned by interaction.fetchReply().
 */
export function buildResultMessageUrl(interaction, replyMessage) {
  if (!interaction?.guildId || !interaction?.channelId || !replyMessage?.id) return undefined;
  return `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${replyMessage.id}`;
}
