/**
 * handlers/list/add/index.js
 * Compose root for the /la-list add flow. Wires the slash-command
 * handler + the three button handlers (approval, view-evidence,
 * overwrite-on-dupe) into a single bag the top-level dispatcher
 * consumes. All four handlers share the same approval-flow services
 * passed in here · keeps the per-file handlers thin.
 */

import { createListAddApprovalButtonHandler } from './approvalButton.js';
import { createListAddCommandHandler } from './command.js';
import { createListAddViewEvidenceButtonHandler } from './evidenceButton.js';
import { createListAddOverwriteButtonHandler } from './overwriteButton.js';

/**
 * Build the four /la-list add handlers as one composed bag.
 * @param {object} deps
 * @param {import('discord.js').Client} deps.client - Discord client (DM
 *   fan-out for approver messages, REST fetches for evidence resolves)
 * @param {object} deps.services - shared approval-flow services
 *   (sendListAddApprovalToApprovers, syncApproverDmMessages,
 *   executeListAddToDatabase, broadcastListChange,
 *   notifyRequesterAboutDecision)
 * @returns {{
 *   handleListAddCommand: Function,
 *   handleListAddApprovalButton: Function,
 *   handleListAddViewEvidenceButton: Function,
 *   handleListAddOverwriteButton: Function,
 * }}
 */
export function createAddHandlers({ client, services }) {
  const {
    sendListAddApprovalToApprovers,
    syncApproverDmMessages,
    executeListAddToDatabase,
    broadcastListChange,
    notifyRequesterAboutDecision,
  } = services;

  return {
    handleListAddCommand: createListAddCommandHandler({
      client,
      sendListAddApprovalToApprovers,
      executeListAddToDatabase,
    }),
    handleListAddApprovalButton: createListAddApprovalButtonHandler({
      client,
      syncApproverDmMessages,
      executeListAddToDatabase,
      broadcastListChange,
      notifyRequesterAboutDecision,
    }),
    handleListAddViewEvidenceButton: createListAddViewEvidenceButtonHandler({ client }),
    handleListAddOverwriteButton: createListAddOverwriteButtonHandler({
      syncApproverDmMessages,
      broadcastListChange,
      notifyRequesterAboutDecision,
    }),
  };
}
