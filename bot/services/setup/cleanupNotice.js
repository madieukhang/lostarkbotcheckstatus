/**
 * services/setup/cleanupNotice.js
 * The sign Artist leaves behind after the daily auto-check sweep.
 *
 * Without it the channel simply looks emptied: someone opening it in the
 * morning cannot tell whether the bot tidied up or whether messages went
 * missing. The notice explains the disappearance.
 *
 * Two deliberate differences from the RaidManage cleanup notice, both driven
 * by cadence. RaidManage sweeps every 30 minutes, so its sign self-deletes
 * after 5 minutes and it posts even on an empty sweep. This sweep runs once a
 * day at 00:00 Asia/Ho_Chi_Minh, so:
 *  - the notice STAYS until the next sweep removes it, otherwise nobody awake
 *    at midnight would be the only person who ever saw it;
 *  - nothing is posted when nothing was deleted, because a nightly "there was
 *    nothing to clean" is noise in a quiet channel.
 */

import { EmbedBuilder } from 'discord.js';

import { tPick } from '../i18n/index.js';
import { COLORS } from '../../utils/ui.js';
import { resolveCleanupVolume } from './cleanupVolume.js';

/**
 * Pick the tone bucket for a sweep result.
 * @param {number} deleted - messages removed by the sweep
 * @returns {'trivial'|'normal'|'heavy'|null} null when there is nothing to say
 */
export function resolveCleanupVolumeBucket(deleted) {
  return resolveCleanupVolume(deleted);
}

/**
 * Build the post-sweep notice embed.
 * @param {number} deleted - messages removed by the sweep
 * @param {string} lang - guild language
 * @param {{translate?: Function}} [deps] - translate injected for tests
 * @returns {import('discord.js').EmbedBuilder|null} null when nothing to post
 */
export function buildCleanupNoticeEmbed(deleted, lang, { translate = tPick } = {}) {
  const bucket = resolveCleanupVolumeBucket(deleted);
  if (!bucket) return null;

  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setDescription(translate(`dialogue.cleanupNotice.${bucket}`, lang, { n: Number(deleted) }))
    .setTimestamp();
}

/**
 * Post the notice, swallowing any failure. Tidying is best-effort commentary;
 * it must never turn a successful sweep into a logged error.
 * @param {import('discord.js').TextChannel} channel
 * @param {number} deleted
 * @param {string} lang
 * @param {{translate?: Function, logger?: Console}} [deps]
 * @returns {Promise<boolean>} whether a notice was actually posted
 */
export async function postCleanupNotice(channel, deleted, lang, { translate, logger = console } = {}) {
  const embed = buildCleanupNoticeEmbed(deleted, lang, translate ? { translate } : {});
  if (!embed) return false;
  try {
    await channel.send({ embeds: [embed] });
    return true;
  } catch (err) {
    logger.warn?.('[auto-check cleanup] notice post failed:', err?.message || err);
    return false;
  }
}
