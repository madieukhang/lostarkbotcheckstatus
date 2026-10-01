/**
 * Compact evidence controls for list-change broadcasts.
 *
 * Public cards stay readable by keeping the ultra-wide screenshot out of the
 * embed. A click resolves the archived attachment again and shows it only to
 * the viewer, which also avoids stale Discord CDN signatures.
 */

import {
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { refreshImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferEphemeralReply, editEmbed } from '../../../utils/interactionReplies.js';
import { ICONS } from '../../../utils/ui.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import UserPreference from '../../../models/UserPreference.js';

export const BROADCAST_EVIDENCE_PREFIX = 'listbroadcast_evidence';
// Handled in entryButton.js, which needs helpers.js; helpers.js imports
// this file, so the prefix lives here to keep the import one-way.
export const ENTRY_EVIDENCE_PREFIX = 'listentry_evidence';

const viewEvidenceButton = (customId, lang) => new ButtonBuilder()
  .setCustomId(customId)
  .setLabel(t('common.actions.viewEvidence', lang))
  .setEmoji('📎')
  .setStyle(ButtonStyle.Secondary);

/**
 * The evidence button for a list entry or request. View evidence opens the
 * image inside Discord: from the archive, or for a stored direct link by
 * looking the entry up again, since the link does not fit in a custom id.
 * Open evidence, a plain link, is left only for a link with no entry to
 * look up: a request, or an entry that was just removed.
 * @param {object} entry - carries imageMessageId/imageChannelId or imageUrl
 * @param {object} [options]
 * @param {string} [options.type] - the entry's list; omit when the entry
 *   cannot be looked up again
 * @param {string} [options.legacyUrl] - direct image link to prefer over entry.imageUrl
 * @param {string} [options.lang='en'] - locale of the label
 * @returns {ButtonBuilder|null} null when the entry has no evidence
 */
export function buildBroadcastEvidenceButton(entry, { type, legacyUrl, lang = 'en' } = {}) {
  const messageId = String(entry?.imageMessageId || '').trim();
  const channelId = String(entry?.imageChannelId || '').trim();
  if (messageId && channelId) {
    return viewEvidenceButton(`${BROADCAST_EVIDENCE_PREFIX}:${channelId}:${messageId}`, lang);
  }
  const directUrl = String(legacyUrl || entry?.imageUrl || '').trim();
  if (!directUrl) return null;
  if (type && entry._id) return viewEvidenceButton(`${ENTRY_EVIDENCE_PREFIX}:${type}:${entry._id}`, lang);
  return new ButtonBuilder()
    .setLabel(t('common.actions.openEvidence', lang))
    .setEmoji('📎')
    .setURL(directUrl)
    .setStyle(ButtonStyle.Link);
}

function parseEvidenceCustomId(customId) {
  const [prefix, channelId, messageId, ...extra] = String(customId || '').split(':');
  if (prefix !== BROADCAST_EVIDENCE_PREFIX || !channelId || !messageId || extra.length > 0) {
    return null;
  }
  return { channelId, messageId };
}

export function createBroadcastEvidenceButtonHandler({
  client,
  refreshImageUrlFn = refreshImageUrl,
  getUserLanguageFn = getUserLanguage,
  UserPreferenceModel = UserPreference,
}) {
  return async function handleBroadcastEvidenceButton(interaction) {
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguageFn(interaction.user?.id, { UserPreferenceModel });

    const ids = parseEvidenceCustomId(interaction.customId);
    const displayUrl = ids
      ? await refreshImageUrlFn(ids.messageId, ids.channelId, client)
      : null;

    if (!displayUrl) {
      await editEmbed(interaction, buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        ...t('dialogue.evidence.missing', lang),
        lang,
      }));
      return;
    }

    const embed = buildAlertEmbed({
      severity: AlertSeverity.INFO,
      titleIcon: ICONS.evidence,
      ...t('dialogue.evidence.archive', lang),
      lang,
    }).setImage(displayUrl);

    await editEmbed(interaction, embed);
  };
}
