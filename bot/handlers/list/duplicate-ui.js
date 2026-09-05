import { buildAlertEmbed, AlertSeverity } from '../../utils/alertEmbed.js';
import { truncateInlineText } from '../../utils/discordText.js';
import { normalizeNameKey } from '../../utils/names.js';
import { relativeTime } from '../../utils/ui.js';
import { t } from '../../services/i18n/index.js';
import { getListContext } from './helpers.js';
import { formatLinkedCharacter } from './trackedAltsRender.js';

/**
 * Full-width reason pair shared by direct-add and approval duplicate cards.
 * Approval always shows the requested value, including the keep-existing fallback.
 * @param {object} existed Stored list entry.
 * @param {string} typedReason Reason submitted with the add request.
 * @param {string} lang Recipient language.
 * @param {{forApproval?: boolean}} options Whether the reader is an approver.
 * @returns {Array<object>} Discord embed fields.
 */
export function buildDuplicateReasonFields(existed, typedReason, lang, { forApproval = false } = {}) {
  const fallback = t('dialogue.broadcast.notAvailable', lang);
  const typed = String(typedReason || '').trim();
  return [
    {
      name: `📝 ${t('dialogue.listAdd.duplicate.storedReason', lang)}`,
      value: (existed.reason || fallback).slice(0, 1024),
      inline: false,
    },
    // Keep identical reasons visible: the reviewer still needs both sides.
    typed || forApproval ? {
      name: `✏️ ${t(forApproval ? 'dialogue.approval.flow.requestReason' : 'dialogue.listAdd.duplicate.typedReason', lang)}`,
      value: (typed || t('dialogue.approval.flow.unchangedValue', lang)).slice(0, 1024),
      inline: false,
    } : null,
  ].filter(Boolean);
}

function buildComparisonMetadata(entry, lang, isRequest = false) {
  const fallback = t('dialogue.broadcast.notAvailable', lang);
  const scope = t(`dialogue.approval.scopeTag.${entry.scope === 'server' ? 'local' : 'global'}`, lang);
  const by = isRequest
    ? entry.requestedByDisplayName || entry.requestedByTag || entry.requestedByName
    : entry.addedByDisplayName || entry.addedByTag || entry.addedByName;
  const raid = entry.raid
    ? `\`${truncateInlineText(entry.raid, 180)}\``
    : isRequest ? t('dialogue.approval.flow.unchangedValue', lang) : fallback;
  return {
    name: `${isRequest ? '🆕' : '📌'} ${t(`dialogue.approval.flow.${isRequest ? 'newRequest' : 'existingEntry'}`, lang)}`,
    value: [
      `${formatLinkedCharacter(entry.name)} \`${scope}\``,
      `🗡️ ${t('dialogue.approval.flow.compareRaid', lang)}: ${raid}`,
      `👤 ${t('dialogue.approval.flow.compareBy', lang)}: ${truncateInlineText(by, 180) || fallback}`,
      !isRequest ? `🕐 ${t('dialogue.approval.flow.compareAdded', lang)}: ${relativeTime(entry.addedAt) || fallback}` : null,
    ].filter(Boolean).join('\n'),
    inline: true,
  };
}

/**
 * Render the pending duplicate decision using only already loaded request/entry data.
 * @param {object} existing Stored duplicate entry.
 * @param {object} payload Pending add request.
 * @param {string} lang Approver language.
 * @returns {import('discord.js').EmbedBuilder} Comparison with reasons before metadata.
 */
export function buildDuplicateApprovalEmbed(existing, payload, lang = 'en') {
  const isRosterMatch = normalizeNameKey(existing.name) !== normalizeNameKey(payload.name);
  return buildAlertEmbed({
    severity: AlertSeverity.WARNING,
    author: `⚠️ ${t('dialogue.approval.flow.duplicateTitle', lang)}`,
    description: t(`dialogue.approval.flow.${isRosterMatch ? 'duplicateRoster' : 'duplicateDirect'}`, lang, {
      icon: getListContext(payload.type).icon,
      name: formatLinkedCharacter(payload.name),
      matched: formatLinkedCharacter(existing.name),
      list: t(`dialogue.broadcast.list.${payload.type}`, lang),
    }),
    fields: [
      ...buildDuplicateReasonFields(existing, payload.reason, lang, { forApproval: true }),
      buildComparisonMetadata(existing, lang),
      buildComparisonMetadata(payload, lang, true),
    ],
    footer: t('dialogue.approval.flow.comparisonFooter', lang),
    timestamp: false,
    lang,
  });
}
