/**
 * Compact evidence controls for list-change broadcasts.
 *
 * Public cards stay readable by keeping the ultra-wide screenshot out of the
 * embed. A click resolves the archived attachment again and shows it only to
 * the viewer, which also avoids stale Discord CDN signatures.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import { refreshImageUrl } from '../../../utils/imageRehost.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { deferEphemeralReply, editEmbed } from '../../../utils/interactionReplies.js';
import { ICONS } from '../../../utils/ui.js';
import { t } from '../../../services/i18n/index.js';

export const BROADCAST_EVIDENCE_PREFIX = 'listbroadcast_evidence';

export function buildBroadcastEvidenceComponents(entry, { legacyUrl, lang = 'en' } = {}) {
  const messageId = String(entry?.imageMessageId || '').trim();
  const channelId = String(entry?.imageChannelId || '').trim();
  let button = null;

  if (messageId && channelId) {
    button = new ButtonBuilder()
      .setCustomId(`${BROADCAST_EVIDENCE_PREFIX}:${channelId}:${messageId}`)
      .setLabel(t('common.actions.viewEvidence', lang))
      .setEmoji('📎')
      .setStyle(ButtonStyle.Secondary);
  } else {
    const directUrl = String(legacyUrl || entry?.imageUrl || '').trim();
    if (directUrl) {
      button = new ButtonBuilder()
        .setLabel(t('common.actions.openEvidence', lang))
        .setEmoji('📎')
        .setURL(directUrl)
        .setStyle(ButtonStyle.Link);
    }
  }

  return button ? [new ActionRowBuilder().addComponents(button)] : [];
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
}) {
  return async function handleBroadcastEvidenceButton(interaction) {
    await deferEphemeralReply(interaction);

    const ids = parseEvidenceCustomId(interaction.customId);
    const displayUrl = ids
      ? await refreshImageUrlFn(ids.messageId, ids.channelId, client)
      : null;

    if (!displayUrl) {
      await editEmbed(interaction, buildAlertEmbed({
        severity: AlertSeverity.WARNING,
        title: 'Evidence slipped away',
        description:
          'I could not reopen this archived screenshot. It may have been deleted, ' +
          'or LoaLogs may no longer have access to its storage channel.',
        footer: 'Ask an officer to attach fresh evidence to the entry.',
      }));
      return;
    }

    const embed = buildAlertEmbed({
      severity: AlertSeverity.INFO,
      titleIcon: ICONS.evidence,
      title: 'Evidence archive',
      description:
        'I kept this screenshot separate so the broadcast stays easy to read. ' +
        'Open the image to inspect it at its natural size.',
      footer: 'Private view · refreshed from the LoaLogs evidence archive',
    }).setImage(displayUrl);

    await editEmbed(interaction, embed);
  };
}
