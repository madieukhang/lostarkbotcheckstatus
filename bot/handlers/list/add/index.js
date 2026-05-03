import { createListAddApprovalButtonHandler } from './approvalButton.js';
import { createListAddCommandHandler } from './command.js';
import { createListAddViewEvidenceButtonHandler } from './evidenceButton.js';
import { createListAddOverwriteButtonHandler } from './overwriteButton.js';

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
