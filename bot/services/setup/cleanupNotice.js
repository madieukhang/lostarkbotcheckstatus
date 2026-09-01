/**
 * services/setup/cleanupNotice.js
 * The sign Artist leaves behind after the daily auto-check sweep.
 *
 * Without it the channel simply looks emptied: someone opening it in the
 * morning cannot tell whether the bot tidied up or whether messages went
 * missing. The notice explains the disappearance.
 *
 * This sweep runs once a day at 00:00 Asia/Ho_Chi_Minh. It keeps the useful
 * RaidManage behavior (a short-lived plain-text sign) while staying quiet when
 * nothing was deleted.
 */

import { tPick } from '../i18n/index.js';
import { resolveCleanupVolume } from './cleanupVolume.js';

export const AUTO_CHECK_CLEANUP_NOTICE_TTL_MS = 5 * 60 * 1000;

/**
 * Pick the tone bucket for a sweep result.
 * @param {number} deleted - messages removed by the sweep
 * @returns {'trivial'|'normal'|'heavy'|null} null when there is nothing to say
 */
export function resolveCleanupVolumeBucket(deleted) {
  return resolveCleanupVolume(deleted);
}

/**
 * Build the post-sweep notice text.
 * @param {number} deleted - messages removed by the sweep
 * @param {string} lang - guild language
 * @param {{translate?: Function}} [deps] - translate injected for tests
 * @returns {string|null} null when nothing should be posted
 */
export function buildCleanupNoticeContent(deleted, lang, { translate = tPick } = {}) {
  const bucket = resolveCleanupVolumeBucket(deleted);
  if (!bucket) return null;

  return translate(`dialogue.cleanupNotice.${bucket}`, lang, { n: Number(deleted) });
}

/**
 * Post the notice, swallowing any failure. Tidying is best-effort commentary;
 * it must never turn a successful sweep into a logged error.
 * @param {import('discord.js').TextChannel} channel
 * @param {number} deleted
 * @param {string} lang
 * @param {{translate?: Function, logger?: Console, setTimeoutFn?: Function}} [deps]
 * @returns {Promise<boolean>} whether a notice was actually posted
 */
export async function postCleanupNotice(
  channel,
  deleted,
  lang,
  {
    translate,
    logger = console,
    setTimeoutFn = setTimeout,
  } = {}
) {
  const content = buildCleanupNoticeContent(deleted, lang, translate ? { translate } : {});
  if (!content) return false;
  try {
    const message = await channel.send({ content });
    const timer = setTimeoutFn(
      () => message.delete().catch(() => {}),
      AUTO_CHECK_CLEANUP_NOTICE_TTL_MS
    );
    timer?.unref?.();
    return true;
  } catch (err) {
    logger.warn?.('[auto-check cleanup] notice post failed:', err?.message || err);
    return false;
  }
}
