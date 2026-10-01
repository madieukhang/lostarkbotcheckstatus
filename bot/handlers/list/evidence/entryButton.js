/**
 * handlers/list/evidence/entryButton.js
 * View evidence for an entry whose screenshot is a stored link rather than
 * an archived message. The button names the entry because the link does
 * not fit in a custom id; a click reads the entry again, re-signs a Discord
 * link and shows the image only to the clicker, or says why it is gone.
 */

import { connectDB } from '../../../db.js';
import UserPreference from '../../../models/UserPreference.js';
import { getUserLanguage, t } from '../../../services/i18n/index.js';
import { AlertSeverity, buildAlertEmbed } from '../../../utils/alertEmbed.js';
import { isLegacyEvidence, resolveDisplayImageUrl } from '../../../utils/imageRehost.js';
import { deferEphemeralReply, editAlert, editEmbed } from '../../../utils/interactionReplies.js';
import { buildScopedListQuery } from '../../../utils/scope.js';
import { ICONS } from '../../../utils/ui.js';
import { getListContext } from '../helpers.js';

// The entry may have been moved into the archive since the button was posted.
const EVIDENCE_COPY = {
  link: { shown: 'dialogue.evidence.legacy', gone: 'dialogue.evidence.legacyGone' },
  archive: { shown: 'dialogue.evidence.archive', gone: 'dialogue.evidence.missing' },
};

/**
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - signs the link refresh
 * @returns {(interaction: object) => Promise<void>} the button handler
 */
export function createEntryEvidenceButtonHandler({ client }) {
  return async function handleEntryEvidenceButton(interaction) {
    await deferEphemeralReply(interaction);
    const lang = await getUserLanguage(interaction.user.id, { UserPreferenceModel: UserPreference });
    const [, type, entryId] = interaction.customId.split(':');
    await connectDB();
    // Same visibility as the check details card: a server-scoped entry only
    // opens inside its own server.
    const entry = await getListContext(type).model.findOne(
      buildScopedListQuery(type, { _id: entryId }, interaction.guild?.id || interaction.guildId || ''),
    ).lean();
    if (!entry) {
      await editAlert(interaction, { severity: AlertSeverity.WARNING, ...t('dialogue.check.entryRemoved', lang), lang });
      return;
    }

    const copy = EVIDENCE_COPY[isLegacyEvidence(entry) ? 'link' : 'archive'];
    const displayUrl = await resolveDisplayImageUrl(entry, client);
    if (!displayUrl) {
      await editAlert(interaction, { severity: AlertSeverity.WARNING, ...t(copy.gone, lang), lang });
      return;
    }
    await editEmbed(interaction, buildAlertEmbed({
      severity: AlertSeverity.INFO, titleIcon: ICONS.evidence, ...t(copy.shown, lang), lang,
    }).setImage(displayUrl));
  };
}
