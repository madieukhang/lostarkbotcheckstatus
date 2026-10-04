/**
 * handlers/list/add/overwriteButton.js
 * "Add to history" + "Keep existing" buttons on the duplicate branch of
 * an approved /la-list add. Add to history saves the request as the
 * entry's latest note, merges a fresh lostark.bible roster and takes a new
 * screenshot as evidence; Keep existing closes the request and tells the
 * requester. The button keeps the listadd_overwrite custom id because the
 * approval lease stores that action string.
 */

import { CASE_INSENSITIVE_COLLATION } from '../../../models/collation.js';
import { buildRosterCharacters } from '../../../services/roster/index.js';
import { normalizeCharacterName } from '../../../utils/names.js';
import { buildNameRosterQuery } from '../../../utils/listEntryMap.js';
import { buildAlertEmbed, AlertSeverity } from '../../../utils/alertEmbed.js';
import { editPayload } from '../../../utils/interactionReplies.js';
import { t } from '../../../services/i18n/index.js';
import {
  getListContext,
  buildApprovalResultRow,
  buildApprovalRetryRow,
  buildDecidedApprovalPayload,
  buildTrustedBlockEmbed,
} from '../helpers.js';
import { findTrustedEditConflict } from '../edit/trustedGuard.js';
import { createApprovalDecisionHandler, handleApprovalClaimError } from '../services/approvalInteraction.js';
import { createApprovalMessageUpdater } from '../services/approvals.js';
import { appendEntryNote, listAddedAlts } from '../notes/appendNote.js';

function buildDuplicateLookupQuery(payload) {
  const nameMatch = buildNameRosterQuery(normalizeCharacterName(payload.name));
  if (payload.type !== 'black') return nameMatch;

  const entryScope = payload.scope || 'global';
  const scopeMatch = entryScope === 'server'
    ? { scope: 'server', guildId: payload.guildId || '' }
    : { $or: [{ scope: 'global' }, { scope: { $exists: false } }] };
  return { $and: [nameMatch, scopeMatch] };
}

export async function findDuplicateEntry(model, payload) {
  const lookupStrategies = [
    () => payload.duplicateEntryId ? model.findById(payload.duplicateEntryId) : null,
    () => model.findOne(buildDuplicateLookupQuery(payload))
      .collation(CASE_INSENSITIVE_COLLATION),
  ];

  for (const lookup of lookupStrategies) {
    const entry = await lookup();
    if (entry) return entry;
  }
  return null;
}

/**
 * Build the Add to history / Keep-existing button handler for the
 * duplicate branch of /la-list add.
 * @param {object} deps
 * @param {Function} deps.syncApproverDmMessages - approver DM sync
 * @param {Function} deps.broadcastListChange - guild broadcast
 * @param {Function} deps.notifyRequesterAboutDecision - origin-channel decision notice
 * @returns {Function} handleListAddOverwriteButton(interaction)
 */
export function createListAddOverwriteButtonHandler({
  syncApproverDmMessages,
  broadcastListChange,
  notifyRequesterAboutDecision,
  buildRosterCharactersFn = buildRosterCharacters,
}) {
  return createApprovalDecisionHandler(async ({ interaction, action, requestId, lang, payload, claim }) => {
    const isAddToHistory = action === 'listadd_overwrite';
    const updateApprovers = createApprovalMessageUpdater({
      interaction, payload, lang, syncApproverDmMessages,
    });

    if (!isAddToHistory) {
      await claim.complete();
      // Keep the existing entry and explain the duplicate to the requester.
      const buildKeptPayload = (targetLang) => buildDecidedApprovalPayload({
        client: interaction.client, payload, outcome: 'kept', approver: interaction.user.tag, lang: targetLang,
      });
      await updateApprovers(buildKeptPayload);

      await notifyRequesterAboutDecision(payload, { ok: false, isDuplicate: true }, true);
      return;
    }

    try {
      const { model } = getListContext(payload.type);

      // Prefer the stored duplicate id, then fall back to a scope-aware name
      // lookup when an older pending approval does not carry that id.
      const dupeEntry = await findDuplicateEntry(model, payload);

      if (!dupeEntry) {
        await claim.complete();
        await editPayload(interaction, {
          content: '',
          embeds: [buildAlertEmbed({
            severity: AlertSeverity.WARNING,
            ...t('dialogue.approval.flow.originalMissing', lang),
            lang,
          })],
          components: [buildApprovalResultRow('Failed', lang)],
        });
        return;
      }

      // The approval may come long after the request, so the roster is
      // fetched again rather than taken from the request.
      const typedName = normalizeCharacterName(payload.name);
      const rosterResult = await buildRosterCharactersFn(typedName, {
        hiddenRosterFallback: true,
      }).catch(() => null);
      const rosterNames = rosterResult?.hasValidRoster ? rosterResult.allCharacters || [] : [];
      const trustedNow = await findTrustedEditConflict({
        name: typedName,
        allCharacters: rosterNames.length > 0 ? rosterNames : dupeEntry.allCharacters || [],
      });
      if (trustedNow) {
        await claim.complete();
        await updateApprovers(targetLang => ({
          content: null,
          embeds: [buildTrustedBlockEmbed(typedName, trustedNow.reason, { lang: targetLang })],
          components: [buildApprovalResultRow('Blocked', targetLang)],
        }));
        await notifyRequesterAboutDecision(payload, { ok: false }, false);
        return;
      }

      // The request id lets a Retry after a failed complete() find the note
      // this run saved instead of saving the report twice.
      const saved = await appendEntryNote({
        model, entry: dupeEntry, payload, rosterNames, requestId, beforeWrite: () => claim.assertOwned(),
      });
      await claim.complete();
      if (!saved) {
        await editPayload(interaction, {
          content: '',
          embeds: [buildAlertEmbed({ severity: AlertSeverity.WARNING, ...t('dialogue.approval.flow.originalMissing', lang), lang })],
          components: [buildApprovalResultRow('Failed', lang)],
        });
        return;
      }

      console.log(`[list] Note added: ${payload.type} entry ${saved.name}`);

      await updateApprovers(targetLang => buildDecidedApprovalPayload({
        client: interaction.client, payload, outcome: 'noted', approver: interaction.user.tag, lang: targetLang,
      }));

      // Server-scoped entries announce to the owner server only.
      broadcastListChange('noted', saved, {
        type: payload.type,
        guildId: payload.guildId,
        requestedByDisplayName: payload.requestedByDisplayName,
        requestedByTag: payload.requestedByTag,
      }, {
        onlyOwner: saved.scope === 'server',
        rosterCharacters: rosterResult?.rosterCharacters || [],
        newAltNames: listAddedAlts(dupeEntry, saved),
      }).catch((err) => console.warn('[list] Broadcast failed:', err.message));

      await notifyRequesterAboutDecision(payload, { ok: true, isNoted: true }, false);
    } catch (err) {
      if (await handleApprovalClaimError({ claim, interaction, error: err, lang, label: 'Add to history' })) return;
      console.error('[list] Add to history failed:', err.message);
      await editPayload(interaction, {
        content: '',
        embeds: [buildAlertEmbed({
          severity: AlertSeverity.WARNING,
          ...t('dialogue.approval.flow.retryFailed', lang),
          fields: [{ name: t('dialogue.common.errorField', lang), value: `\`${err.message}\``, inline: false }],
          lang,
        })],
        components: [buildApprovalRetryRow('listadd_overwrite', requestId, lang)],
      });
    }
  });
}
