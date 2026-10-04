/**
 * utils/seniorGate.js
 * Handler-side senior check for the owner-server commands. Registering a
 * command only in OWNER_GUILD_ID is not a permission, so each handler asks.
 */

import config from '../config.js';
import { AlertSeverity } from './alertEmbed.js';
import { editAlert } from './interactionReplies.js';
import { t } from '../services/i18n/index.js';

/**
 * Answer a caller who is not a senior approver with the given notice.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction - deferred interaction
 * @param {string} lang - caller's language
 * @param {string} noticeKey - dialogue key holding the notice title and description
 * @returns {Promise<boolean>} true when the caller was turned away
 */
export async function rejectNonSenior(interaction, lang, noticeKey) {
  if (config.seniorApproverIds.includes(interaction.user.id)) return false;
  await editAlert(interaction, {
    severity: AlertSeverity.ERROR,
    ...t(noticeKey, lang),
    lang,
  });
  return true;
}
