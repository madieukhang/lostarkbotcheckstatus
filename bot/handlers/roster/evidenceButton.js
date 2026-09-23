/**
 * handlers/roster/evidenceButton.js
 * One /la-roster button per blacklist / watchlist / whitelist entry the
 * roster matched. The public roster card only names each hit; a click shows
 * that entry's full report, image included, to the clicker alone. The id
 * holds no session, so the buttons keep working after a restart.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

import UserPreference from '../../models/UserPreference.js';
import { AlertSeverity } from '../../utils/alertEmbed.js';
import { deferEphemeralReply, editNotice } from '../../utils/interactionReplies.js';
import { getUserLanguage, t } from '../../services/i18n/index.js';
import { editWithListEntryDetails } from '../list/check/index.js';
import { getListContext, parseListEntryRef } from '../list/helpers.js';

export const ROSTER_EVIDENCE_PREFIX = 'roster_evidence:';

/**
 * @param {Array<{listType: string, entry: object}>} hits - list hits in card order
 * @param {string} lang
 * @returns {ActionRowBuilder[]} one row with a button per hit, or none
 */
export function buildRosterEvidenceRows(hits, lang) {
  if (hits.length === 0) return [];
  return [new ActionRowBuilder().addComponents(hits.map(({ listType, entry }) => new ButtonBuilder()
    .setCustomId(`${ROSTER_EVIDENCE_PREFIX}${listType}:${entry._id}`)
    .setLabel(`${t('common.actions.viewEvidence', lang)} · ${t(`listView.labels.${listType}`, lang)}`)
    .setEmoji(getListContext(listType).icon)
    .setStyle(ButtonStyle.Secondary)))];
}

/**
 * @param {import('discord.js').ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleRosterEvidenceButton(interaction) {
  await deferEphemeralReply(interaction);
  const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
  const ref = parseListEntryRef(interaction.customId.slice(ROSTER_EVIDENCE_PREFIX.length));
  if (!ref) {
    await editNotice(interaction, t('dialogue.check.malformed', lang), {
      severity: AlertSeverity.WARNING,
      lang,
    });
    return;
  }
  await editWithListEntryDetails(interaction, ref, { client: interaction.client, lang });
}
