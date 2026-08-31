import { EmbedBuilder } from 'discord.js';

import { tPick } from '../i18n/index.js';
import { COLORS } from '../../utils/ui.js';
import { resolveCleanupVolume } from './cleanupVolume.js';

export const LIST_NOTIFY_CLEANUP_NOTICE_TTL_MS = 5 * 60 * 1000;

export function resolveListNotifyCleanupVolumeBucket(deleted) {
  return resolveCleanupVolume(deleted, { emptyBucket: 'empty' });
}

export function buildListNotifyCleanupNoticeEmbed(
  deleted,
  lang,
  { translate = tPick } = {}
) {
  const count = Number(deleted) || 0;
  const bucket = resolveListNotifyCleanupVolumeBucket(count);
  return new EmbedBuilder()
    .setColor(COLORS.muted)
    .setDescription(translate(
      `dialogue.listNotifyCleanupNotice.${bucket}`,
      lang,
      { n: count }
    ))
    .setTimestamp();
}

/** RaidManage-style short-lived sign posted after each half-hour sweep. */
export async function postListNotifyCleanupNotice(
  channel,
  deleted,
  lang,
  {
    logger = console,
    setTimeoutFn = setTimeout,
    translate,
  } = {}
) {
  try {
    const embed = buildListNotifyCleanupNoticeEmbed(
      deleted,
      lang,
      translate ? { translate } : {}
    );
    const message = await channel.send({ embeds: [embed] });
    const timer = setTimeoutFn(
      () => message.delete().catch(() => {}),
      LIST_NOTIFY_CLEANUP_NOTICE_TTL_MS
    );
    timer?.unref?.();
    return true;
  } catch (err) {
    logger.warn?.('[list-notify cleanup] notice post failed:', err?.message || err);
    return false;
  }
}
