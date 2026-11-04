import { buildAlertEmbed, NoticeKind } from './alertEmbed.js';
import { isPrivilegedStrongholdScanUser } from './scanPermissions.js';
import { reserveUserScan } from './scanSession.js';
import { t } from '../services/i18n/index.js';

export function reserveStrongholdScanForInteraction(interaction, label) {
  return reserveUserScan(interaction.user.id, {
    label,
    startedAt: Date.now(),
  }, {
    allowMultiple: isPrivilegedStrongholdScanUser(interaction.user.id),
  });
}

/**
 * Alert options for a Stronghold scan refused because another scan is running.
 *
 * @param {object|null} active - the running scan's reservation, read for its `label`
 * @param {string} [lang] - language of the alert text
 * @returns {object} options for buildAlertEmbed or replyAlert
 */
export function scanLimitAlertOptions(active, lang = 'en') {
  const { title, description, tip, runningField } = t('dialogue.scan.limit', lang);
  return {
    kind: NoticeKind.BUSY,
    title,
    description,
    tip,
    fields: active?.label ? [{ name: runningField, value: `\`${active.label}\``, inline: false }] : [],
  };
}

/**
 * Embed for a Stronghold scan refused because another scan is running.
 * @param {object|null} active - the running scan's reservation, read for its `label`
 * @param {string} [lang] - language of the alert text
 * @returns {import('discord.js').EmbedBuilder}
 */
export function buildStrongholdScanLimitEmbed(active, lang = 'en') {
  return buildAlertEmbed(scanLimitAlertOptions(active, lang));
}
