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

/**
 * @typedef ScanDmOptions
 * @property {import('discord.js').User} user - The slash command caller (interaction.user).
 * @property {string} commandLabel - "/la-list enrich" or "/la-roster deep:true".
 * @property {string} scanTargetName - Character name the scan ran against.
 * @property {string} [guildName] - Bible-side guild name; rendered as context.
 * @property {string} [channelMention] - "<#channelId>" so the DM links the channel.
 * @property {string} [resultMessageUrl] - Discord message URL to attach as a Link button.
 * @property {'completed'|'no-alts'|'stopped-with-alts'|'stopped-no-alts'|'enrich-saved'} outcome
 * @property {object} [result] - Scan result: { scannedCandidates, failedCandidates, alts? }
 * @property {Array} [alts] - Optional override for the alt list (use this when
 *   the caller has filtered the alts down to "new only" before DM).
 */

const OUTCOME_STYLE = {
  'completed':         { icon: ICONS.done,   suffix: 'finished',          color: 'success' },
  'enrich-saved':      { icon: ICONS.done,   suffix: 'saved',             color: 'success' },
  'no-alts':           { icon: ICONS.search, suffix: 'finished · 0 alts', color: 'info'    },
  'stopped-with-alts': { icon: '🛑',         suffix: 'stopped (partial)', color: 'warning' },
  'stopped-no-alts':   { icon: '🛑',         suffix: 'stopped · 0 alts',  color: 'muted'   },
};

function pickColor(token) {
  return COLORS[token] ?? COLORS.info;
}

function buildAltLines(alts = []) {
  if (!alts.length) return '';
  const visible = alts.slice(0, 10);
  const lines = visible.map((alt, i) => {
    const link = `https://lostark.bible/character/NA/${encodeURIComponent(alt.name)}/roster`;
    const cls = alt.className || alt.classId || '?';
    const ilvl = typeof alt.itemLevel === 'number'
      ? alt.itemLevel.toFixed(2)
      : (alt.itemLevel || '?');
    return `${i + 1}. **[${alt.name}](${link})** · ${cls} · \`${ilvl}\``;
  });
  const extra = alts.length > visible.length
    ? `\n*... and ${alts.length - visible.length} more*`
    : '';
  return `\n\n**Matches (${alts.length}):**\n${lines.join('\n')}${extra}`;
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
    outcome,
    result = {},
    alts: altsOverride,
  } = opts;

  const style = OUTCOME_STYLE[outcome] ?? OUTCOME_STYLE.completed;
  const alts = altsOverride ?? result.alts ?? [];
  const altsBlock = buildAltLines(alts);

  const lines = [];
  lines.push(`Your \`${commandLabel}\` scan${channelMention ? ` in ${channelMention}` : ''} has finished.`);
  if (guildName) {
    lines.push('');
    lines.push(`Guild: **${guildName}**`);
  }

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Lost Ark Check · Scan notification' })
    .setTitle(`${style.icon} Scan ${style.suffix} · ${scanTargetName}`)
    .setDescription(lines.join('\n') + altsBlock)
    .setColor(pickColor(style.color))
    .addFields(
      { name: 'Scanned',    value: String(result.scannedCandidates ?? 0),    inline: true },
      { name: 'Found',      value: String(alts.length),                       inline: true },
      { name: 'Failed',     value: String(result.failedCandidates ?? 0),      inline: true },
    )
    .setFooter({ text: 'You ran the command, so you got the heads-up. Block the bot if these DMs are unwanted.' })
    .setTimestamp();

  const components = [];
  if (resultMessageUrl) {
    components.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Jump to result')
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
